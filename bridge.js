const mqtt_library = require('mqtt');
const file_reader   = require('fs');
const path_tool     = require('path');
const net           = require('net');
const os            = require('os');

// ─── Load Config ──────────────────────────────────────────────────────────────
const setup_file_location = path_tool.join(process.cwd(), 'config.json');
let cfg;
try {
  cfg = JSON.parse(file_reader.readFileSync(setup_file_location, 'utf8'));
} catch (e) {
  console.error('Failed to read config.json', e);
  process.exit(1);
}

const DEBUG         = cfg.debug_logging === true;
const WRITE_TO_FILE = cfg.write_logs_to_file !== false;

// ─── Session Log File ─────────────────────────────────────────────────────────
let log_file_stream = null;
let log_file_path   = null;

if (WRITE_TO_FILE) {
  const log_dir = path_tool.join(process.cwd(), 'logs');
  if (!file_reader.existsSync(log_dir)) file_reader.mkdirSync(log_dir, { recursive: true });

  const session_start   = new Date();
  const session_stamp   = session_start.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  log_file_path   = path_tool.join(log_dir, `bridge_log_${session_stamp}.txt`);
  log_file_stream = file_reader.createWriteStream(log_file_path, { flags: 'a' });
}

const session_start = new Date();

// Write a line to both console and the session log file (if enabled)
function write_log_line(line) {
  console.log(line);
  if (WRITE_TO_FILE && log_file_stream) {
    log_file_stream.write(line + os.EOL);
  }
}

// Tagged log — mirrors what we had before, but also goes to file
const log = (tag, msg) => write_log_line(`[${tag}] ${msg}`);
const dbg = (msg)      => { if (DEBUG) log('DEBUG', msg); };

// Called once on startup
write_log_line('═'.repeat(60));
write_log_line(`  Bridge Session Started : ${session_start.toISOString()}`);
if (WRITE_TO_FILE) {
  write_log_line(`  Log file              : ${log_file_path}`);
} else {
  write_log_line(`  Log file              : DISABLED`);
}
write_log_line(`  Hostname              : ${os.hostname()}`);
write_log_line('═'.repeat(60));

/**
 * file_log(direction, label, lines)
 * Writes a clearly-formatted block to the log for:
 *   RECEIVED  — raw data coming in from DTU
 *   SENT      — payload dispatched to MQTT or dev-bridge
 *
 * @param {'RECEIVED'|'SENT'|'EVENT'} direction
 * @param {string}   label  Short description (e.g. "DTU 102.176.129.40")
 * @param {string[]} lines  Array of detail lines
 */
function file_log(direction, label, lines) {
  if (!WRITE_TO_FILE || !log_file_stream) return;
  const ts     = new Date().toISOString();
  const header = `┌─[${direction}]─ ${label} ─ ${ts}`;
  const body   = lines.map(l => `│  ${l}`).join(os.EOL);
  const footer = '└' + '─'.repeat(58);
  log_file_stream.write([header, body, footer, ''].join(os.EOL));
}

// ─── 1. MQTT Forwarding Agent (LakeLedger TLS) ────────────────────────────────
const mqtt_opts = {
  username:           cfg.username,
  password:           cfg.password,
  rejectUnauthorized: true,
  clientId:           'lakeledger-bridge-' + Math.random().toString(16).slice(2, 8),
  clean:              true,
  reconnectPeriod:    5000,
};

const ca_path = path_tool.join(process.cwd(), '..', '2_TLS_Certificate', 'lakeledger-ca.crt');
if (file_reader.existsSync(ca_path)) {
  mqtt_opts.ca = file_reader.readFileSync(ca_path);
}

const mqtt_client = mqtt_library.connect(cfg.remote_broker || 'mqtts://mqtt.getlakeledger.com:8883', mqtt_opts);
mqtt_client.on('connect', () => log('MQTT',  'Securely connected to LakeLedger broker!'));
mqtt_client.on('error',   (e) => log('ERROR', `LakeLedger MQTT issue: ${e.message}`));

function publish_mqtt(payload_str, topic_override) {
  const topic = topic_override || cfg.publish_topic;
  mqtt_client.publish(topic, payload_str, { qos: 1 }, (err) => {
    if (err) {
      log('ERROR', `MQTT publish failed: ${err.message}`);
      file_log('SENT', 'MQTT — FAILED', [
        `Topic   : ${topic}`,
        `Payload : ${payload_str}`,
        `Error   : ${err.message}`,
      ]);
    } else {
      log('SUCCESS', `LakeLedger MQTT  ←  [${topic}]  ${payload_str}`);
      file_log('SENT', 'MQTT — LakeLedger', [
        `Topic   : ${topic}`,
        `Payload : ${payload_str}`,
      ]);
    }
  });
}

// ─── 2. Developer TCP Bridge Forwarder (CSV) ──────────────────────────────────
const dev_tcp_cfg = cfg.developer_tcp_bridge;

function forward_csv_to_dev_bridge(do_val, temp_val, sat_val) {
  if (!dev_tcp_cfg || !dev_tcp_cfg.enabled) return;
  const lake_id   = cfg.lake_id   || 'unknown_lake';
  const sensor_id = cfg.sensor_id || 'unknown_sensor';
  const csv_line  = `${lake_id},${sensor_id},${do_val},${temp_val},${sat_val}\n`;
  dbg(`Connecting to developer TCP bridge ${dev_tcp_cfg.host}:${dev_tcp_cfg.port} ...`);
  const dev_sock = new net.Socket();
  dev_sock.connect(dev_tcp_cfg.port, dev_tcp_cfg.host, () => {
    dev_sock.write(csv_line);
    log('SUCCESS', `Developer TCP Bridge  ←  ${csv_line.trim()}`);
    file_log('SENT', `Dev Bridge ${dev_tcp_cfg.host}:${dev_tcp_cfg.port}`, [
      `CSV     : ${csv_line.trim()}`,
    ]);
    dev_sock.destroy();
  });
  dev_sock.on('error', (err) => {
    log('ERROR', `Developer TCP bridge failed: ${err.message}`);
    file_log('SENT', 'Dev Bridge — FAILED', [`Error: ${err.message}`]);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. MQTT BINARY PROTOCOL HELPERS
//     The DTU in MQTT mode speaks real MQTT 3.1.1 binary protocol.
//     Our bridge acts as a mini-broker: CONNACK, PUBACK, PINGRESP, SUBACK.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decode MQTT variable-length remaining length field.
 * Returns { value, bytesUsed } or null on error.
 * Per MQTT 3.1.1 spec §2.2.3 — up to 4 bytes, 7 bits each, MSB = continuation.
 */
function mqtt_decode_remaining_length(buf, startIndex) {
  let multiplier = 1;
  let value = 0;
  let index = startIndex;
  let bytesUsed = 0;

  do {
    if (index >= buf.length) return null;           // buffer too short
    const encodedByte = buf[index++];
    bytesUsed++;
    value += (encodedByte & 0x7F) * multiplier;
    if (multiplier > 128 * 128 * 128) return null;  // malformed (>4 bytes)
    multiplier *= 128;
    if ((encodedByte & 0x80) === 0) break;          // no continuation bit
  } while (true);

  return { value, bytesUsed };
}

/**
 * Encode an integer as MQTT variable-length remaining length bytes.
 */
function mqtt_encode_remaining_length(len) {
  const bytes = [];
  do {
    let encodedByte = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) encodedByte |= 0x80;
    bytes.push(encodedByte);
  } while (len > 0);
  return Buffer.from(bytes);
}

// MQTT Packet Type constants (upper 4 bits of byte 0)
const MQTT_CONNECT     = 1;   // 0x10
const MQTT_CONNACK     = 2;   // 0x20
const MQTT_PUBLISH     = 3;   // 0x30
const MQTT_PUBACK      = 4;   // 0x40
const MQTT_SUBSCRIBE   = 8;   // 0x80
const MQTT_SUBACK      = 9;   // 0x90
const MQTT_PINGREQ     = 12;  // 0xC0
const MQTT_PINGRESP    = 13;  // 0xD0
const MQTT_DISCONNECT  = 14;  // 0xE0

/**
 * Parse a single MQTT binary packet from a buffer.
 * Returns { packetType, flags, remainingLength, headerSize, payload } or null.
 */
function mqtt_parse_fixed_header(buf) {
  if (buf.length < 2) return null;

  const byte0      = buf[0];
  const packetType = (byte0 >> 4) & 0x0F;
  const flags      = byte0 & 0x0F;

  const rl = mqtt_decode_remaining_length(buf, 1);
  if (!rl) return null;

  const headerSize = 1 + rl.bytesUsed;
  const totalSize  = headerSize + rl.value;

  if (buf.length < totalSize) return null;  // incomplete packet

  return {
    packetType,
    flags,
    remainingLength: rl.value,
    headerSize,
    totalSize,
    payload: buf.slice(headerSize, totalSize),
  };
}

/**
 * Parse MQTT CONNECT packet payload.
 * Returns { protocolName, protocolLevel, connectFlags, keepAlive, clientId, username, password }
 */
function mqtt_parse_connect(payload) {
  let offset = 0;

  // Protocol Name
  const protoLen = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
  const protocolName = payload.slice(offset, offset + protoLen).toString('utf8'); offset += protoLen;

  // Protocol Level
  const protocolLevel = payload[offset++];

  // Connect Flags
  const connectFlags = payload[offset++];
  const hasUsername = !!(connectFlags & 0x80);
  const hasPassword = !!(connectFlags & 0x40);
  const cleanSession = !!(connectFlags & 0x02);

  // Keep Alive
  const keepAlive = (payload[offset] << 8) | payload[offset + 1]; offset += 2;

  // Client ID
  const clientIdLen = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
  const clientId = payload.slice(offset, offset + clientIdLen).toString('utf8'); offset += clientIdLen;

  // Username (optional)
  let username = '';
  if (hasUsername && offset < payload.length) {
    const uLen = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
    username = payload.slice(offset, offset + uLen).toString('utf8'); offset += uLen;
  }

  // Password (optional)
  let password = '';
  if (hasPassword && offset < payload.length) {
    const pLen = (payload[offset] << 8) | payload[offset + 1]; offset += 2;
    password = payload.slice(offset, offset + pLen).toString('utf8'); offset += pLen;
  }

  return { protocolName, protocolLevel, connectFlags, keepAlive, clientId, username, password, cleanSession };
}

/**
 * Parse MQTT PUBLISH packet.
 * Returns { topic, payload, packetId (if QoS>0) }
 */
function mqtt_parse_publish(flags, remainingPayload) {
  const qos = (flags >> 1) & 0x03;
  let offset = 0;

  // Topic
  const topicLen = (remainingPayload[offset] << 8) | remainingPayload[offset + 1]; offset += 2;
  const topic = remainingPayload.slice(offset, offset + topicLen).toString('utf8'); offset += topicLen;

  // Packet ID (only for QoS 1 and 2)
  let packetId = 0;
  if (qos > 0) {
    packetId = (remainingPayload[offset] << 8) | remainingPayload[offset + 1]; offset += 2;
  }

  // Payload — everything remaining
  const payload = remainingPayload.slice(offset).toString('utf8');

  return { topic, payload, packetId, qos };
}

/**
 * Parse MQTT SUBSCRIBE packet.
 * Returns { packetId, topics: [{ topic, qos }] }
 */
function mqtt_parse_subscribe(remainingPayload) {
  let offset = 0;

  // Packet ID
  const packetId = (remainingPayload[offset] << 8) | remainingPayload[offset + 1]; offset += 2;

  // Topic filters
  const topics = [];
  while (offset < remainingPayload.length) {
    const topicLen = (remainingPayload[offset] << 8) | remainingPayload[offset + 1]; offset += 2;
    const topic = remainingPayload.slice(offset, offset + topicLen).toString('utf8'); offset += topicLen;
    const qos = remainingPayload[offset++];
    topics.push({ topic, qos });
  }

  return { packetId, topics };
}

// ─── Build MQTT response packets ─────────────────────────────────────────────

function mqtt_build_connack(returnCode) {
  // CONNACK = 0x20, remaining length = 2, session present = 0, return code
  return Buffer.from([0x20, 0x02, 0x00, returnCode & 0xFF]);
}

function mqtt_build_puback(packetId) {
  // PUBACK = 0x40, remaining length = 2, packet ID (2 bytes)
  return Buffer.from([0x40, 0x02, (packetId >> 8) & 0xFF, packetId & 0xFF]);
}

function mqtt_build_suback(packetId, grantedQosList) {
  // SUBACK = 0x90, remaining length = 2 + N, packet ID, then granted QoS for each topic
  const rl = 2 + grantedQosList.length;
  const buf = Buffer.alloc(2 + rl);
  buf[0] = 0x90;
  buf[1] = rl;
  buf[2] = (packetId >> 8) & 0xFF;
  buf[3] = packetId & 0xFF;
  for (let i = 0; i < grantedQosList.length; i++) {
    buf[4 + i] = grantedQosList[i];
  }
  return buf;
}

function mqtt_build_pingresp() {
  // PINGRESP = 0xD0, remaining length = 0
  return Buffer.from([0xD0, 0x00]);
}


// ─── 4. Packet Decoder (extended with full MQTT binary protocol) ──────────────
/**
 * Classifies every raw packet the DTU sends and returns a structured result.
 *
 * Known packet types
 * ──────────────────
 *  HEARTBEAT        — single byte 0x30 or ASCII "0" / "Q"
 *  MQTT_TEXT_LOGIN  — "PUB <topic>" text login frame (transparent mode)
 *  MQTT_TEXT_PUB    — "PUB <topic> <payload>" text publish (transparent mode)
 *  MQTT_CONNECT     — binary MQTT CONNECT packet (MQTT mode)
 *  MQTT_PUBLISH     — binary MQTT PUBLISH packet (MQTT mode)
 *  MQTT_SUBSCRIBE   — binary MQTT SUBSCRIBE packet (MQTT mode)
 *  MQTT_PINGREQ     — binary MQTT PINGREQ packet (MQTT mode)
 *  MQTT_DISCONNECT  — binary MQTT DISCONNECT packet (MQTT mode)
 *  JSON             — packet that contains a {...} JSON object
 *  MODBUS           — binary frame starting with a valid Modbus RTU signature
 *  UNKNOWN          — anything else (still logged in full)
 */
function decode_packet(data) {
  const raw_str   = data.toString('utf8');
  const trimmed   = raw_str.trim();
  const hex       = data.toString('hex');
  const byte0     = data[0];
  const pktType   = (byte0 >> 4) & 0x0F;

  // ── HEARTBEAT ──────────────────────────────────────────────────────────────
  // Single-byte 0x30 (ASCII "0"), single byte 0x51 ("Q"), or the literal string "0"
  if (data.length <= 2 && (trimmed === '0' || trimmed === 'Q' || byte0 === 0x30)) {
    return {
      type:    'HEARTBEAT',
      summary: `Heartbeat packet (raw: "${trimmed}", hex: ${hex})`,
      forward: false,
    };
  }

  // ── BINARY MQTT PACKETS (MQTT mode) ────────────────────────────────────────
  // Must check BEFORE text-based PUB to avoid misclassifying binary frames.
  const mqttPkt = mqtt_parse_fixed_header(data);

  if (mqttPkt) {
    // ── MQTT CONNECT (0x10) ──────────────────────────────────────────────────
    if (pktType === MQTT_CONNECT) {
      try {
        const conn = mqtt_parse_connect(mqttPkt.payload);
        return {
          type:     'MQTT_CONNECT',
          summary:  `MQTT CONNECT  →  client="${conn.clientId}"  user="${conn.username}"  keepAlive=${conn.keepAlive}s  proto=${conn.protocolName}/${conn.protocolLevel}`,
          connect:  conn,
          forward:  false,
          respond:  'CONNACK',
        };
      } catch (e) {
        log('WARN', `Failed to parse MQTT CONNECT: ${e.message}`);
      }
    }

    // ── MQTT PUBLISH (0x30-0x3F) ─────────────────────────────────────────────
    if (pktType === MQTT_PUBLISH && data.length > 4) {
      try {
        const pub = mqtt_parse_publish(mqttPkt.flags, mqttPkt.payload);
        let json_payload = null;
        try { json_payload = JSON.parse(pub.payload); } catch (_) {}

        return {
          type:         'MQTT_PUBLISH',
          summary:      `MQTT PUBLISH  →  topic="${pub.topic}"  qos=${pub.qos}  packetId=${pub.packetId}  payload="${pub.payload.length > 200 ? pub.payload.slice(0, 200) + '…' : pub.payload}"`,
          topic:        pub.topic,
          payload:      pub.payload,
          json_payload,
          packetId:     pub.packetId,
          qos:          pub.qos,
          forward:      true,
          respond:      pub.qos >= 1 ? 'PUBACK' : null,
        };
      } catch (e) {
        log('WARN', `Failed to parse MQTT PUBLISH: ${e.message}`);
      }
    }

    // ── MQTT SUBSCRIBE (0x82) ────────────────────────────────────────────────
    if (pktType === MQTT_SUBSCRIBE) {
      try {
        const sub = mqtt_parse_subscribe(mqttPkt.payload);
        return {
          type:      'MQTT_SUBSCRIBE',
          summary:   `MQTT SUBSCRIBE  →  packetId=${sub.packetId}  topics=[${sub.topics.map(t => `"${t.topic}" (QoS ${t.qos})`).join(', ')}]`,
          subscribe: sub,
          forward:   false,
          respond:   'SUBACK',
        };
      } catch (e) {
        log('WARN', `Failed to parse MQTT SUBSCRIBE: ${e.message}`);
      }
    }

    // ── MQTT PINGREQ (0xC0) ──────────────────────────────────────────────────
    if (pktType === MQTT_PINGREQ) {
      return {
        type:    'MQTT_PINGREQ',
        summary: 'MQTT PINGREQ — DTU keepalive ping',
        forward: false,
        respond: 'PINGRESP',
      };
    }

    // ── MQTT DISCONNECT (0xE0) ───────────────────────────────────────────────
    if (pktType === MQTT_DISCONNECT) {
      return {
        type:    'MQTT_DISCONNECT',
        summary: 'MQTT DISCONNECT — DTU is disconnecting cleanly',
        forward: false,
      };
    }

    // ── MQTT PUBACK (0x40) — DTU acknowledging our publish (unlikely but handle) ──
    if (pktType === MQTT_PUBACK) {
      const packetId = (mqttPkt.payload[0] << 8) | mqttPkt.payload[1];
      return {
        type:    'MQTT_PUBACK',
        summary: `MQTT PUBACK  →  packetId=${packetId}`,
        forward: false,
      };
    }
  }

  // ── PLAIN TEXT "PUB <topic>" — transparent mode DTU firmware ───────────────
  if (trimmed.startsWith('PUB ')) {
    const parts   = trimmed.slice(4).split(' '); // skip "PUB "
    const topic   = parts[0] || '';
    const payload = parts.slice(1).join(' ').trim();

    // If there is no space after the topic the whole remainder IS the topic (login-only frame)
    if (!payload) {
      return {
        type:    'MQTT_TEXT_LOGIN',
        summary: `DTU Topic Registration (text)  →  Topic: "${topic}"`,
        topic,
        payload: null,
        forward: false,  // login frame — nothing to forward yet
      };
    }

    // There is a payload — try to parse it as JSON
    let json_payload = null;
    const json_start = payload.indexOf('{');
    if (json_start !== -1) {
      try { json_payload = JSON.parse(payload.slice(json_start)); } catch (_) {}
    }

    return {
      type:         'MQTT_TEXT_PUB',
      summary:      `Text PUB  →  topic="${topic}"  payload="${payload}"`,
      topic,
      payload,
      json_payload,
      forward:      true,
    };
  }

  // ── JSON somewhere in the packet ────────────────────────────────────────────
  const json_start = trimmed.indexOf('{');
  if (json_start !== -1) {
    const json_str = trimmed.slice(json_start);
    let parsed = null;
    let parse_error = null;
    try { parsed = JSON.parse(json_str); } catch (e) { parse_error = e.message; }

    return {
      type:        'JSON',
      summary:     `JSON payload${parse_error ? ' (MALFORMED)' : ''}`,
      raw_json:    json_str,
      parsed,
      parse_error,
      forward:     true,
    };
  }

  // ── MODBUS RTU heuristic — first byte = device address (1-247), second = function code ──
  if (data.length >= 4 && byte0 >= 1 && byte0 <= 247) {
    const func_code = data[1];
    const KNOWN_FC  = [1, 2, 3, 4, 5, 6, 15, 16];
    if (KNOWN_FC.includes(func_code)) {
      const reg_hi = data[2], reg_lo = data[3];
      const reg    = (reg_hi << 8) | reg_lo;
      return {
        type:    'MODBUS',
        summary: `Modbus RTU  →  device=${byte0}  fc=${func_code}  reg=0x${reg.toString(16).toUpperCase().padStart(4,'0')}  (${data.length} bytes)`,
        hex,
        forward: false,   // we don't know how to parse DO/Temp from this yet
        hint:    'Enable Modbus decoding in config.json to forward Modbus frames.',
      };
    }
  }

  // ── UNKNOWN ─────────────────────────────────────────────────────────────────
  return {
    type:    'UNKNOWN',
    summary: `Unrecognised packet  (${data.length} bytes, hex: ${hex.slice(0, 60)}${hex.length > 60 ? '...' : ''})`,
    forward: false,
  };
}

// ─── Sensor data extraction helper ──────────────────────────────────────────
/**
 * Given a parsed JSON payload (from either MQTT mode or transparent mode),
 * extract sensor readings and forward to LakeLedger + developer bridge.
 */
function extract_and_forward(parsed_json, topic_override) {
  const readings = parsed_json.sensorDatas || parsed_json.sensorData || [];
  let do_val   = 0, temp_val = 0, sat_val = '';
  let mqtt_payload;

  if (readings.length >= 1) {
    do_val   = parseFloat(readings[0].value || 0);
    temp_val = readings.length > 1 ? parseFloat(readings[1].value || 0) : 0.0;
    sat_val  = readings.length > 2 ? parseFloat(readings[2].value || 0) : '';
    mqtt_payload = JSON.stringify({ dissolved_oxygen: do_val, water_temp: temp_val });
  } else {
    // Forward entire JSON as-is if no sensorDatas structure
    mqtt_payload = JSON.stringify(parsed_json);
    // Try to extract known keys directly
    if (parsed_json.dissolved_oxygen !== undefined || parsed_json.water_temp !== undefined) {
      do_val   = parseFloat(parsed_json.dissolved_oxygen || 0);
      temp_val = parseFloat(parsed_json.water_temp || 0);
    }
  }

  log('DATA', `[PARSED] DO=${do_val} | Temp=${temp_val} | Sat=${sat_val}`);
  publish_mqtt(mqtt_payload, topic_override || cfg.publish_topic);
  forward_csv_to_dev_bridge(do_val, temp_val, sat_val);
}


// ─── 5. DTU Raw TCP Receiver (Port 3000) — Now with MQTT broker support ──────
const open_port = cfg.local_http_port || 3000;

const tcp_server = net.createServer((socket) => {
  const remoteAddr = socket.remoteAddress;
  log('INFO', `New DTU connection from [${remoteAddr}]`);

  let has_data = false;
  let is_mqtt_session = false;  // Track if this connection speaks MQTT binary
  let dtu_client_id = '';
  let registered_topic = '';    // Topic from PUB login or MQTT SUBSCRIBE/PUBLISH
  let inputBuffer = Buffer.alloc(0);  // Buffer for reassembling fragmented MQTT packets

  socket.on('data', (incoming) => {
    try {
      has_data = true;

      // ── Quick security filter — DTU never sends HTTP ──
      const raw_check = incoming.toString('utf8').trim();
      const HTTP_VERBS = ['GET ', 'POST ', 'PUT ', 'DELETE ', 'HEAD ', 'OPTIONS ', 'PATCH '];
      if (HTTP_VERBS.some(v => raw_check.startsWith(v)) ||
          raw_check.includes('HTTP/') ||
          raw_check.includes('jsonrpc') ||
          raw_check.includes('winnt')) {
        dbg(`[SECURITY] Blocked HTTP probe from [${remoteAddr}]`);
        socket.destroy();
        return;
      }

      // Append to buffer (MQTT packets may arrive fragmented or concatenated)
      inputBuffer = Buffer.concat([inputBuffer, incoming]);

      // Process all complete packets in the buffer
      while (inputBuffer.length > 0) {
        // Try to parse as MQTT fixed header to determine packet boundaries
        const mqttHeader = mqtt_parse_fixed_header(inputBuffer);

        let packetData;
        if (mqttHeader && is_mqtt_session) {
          // MQTT session: consume exactly one MQTT packet from buffer
          packetData = inputBuffer.slice(0, mqttHeader.totalSize);
          inputBuffer = inputBuffer.slice(mqttHeader.totalSize);
        } else if (!is_mqtt_session) {
          // Not yet identified as MQTT — try full buffer as one packet
          // Check if this is the initial MQTT CONNECT
          if (mqttHeader && ((inputBuffer[0] >> 4) & 0x0F) === MQTT_CONNECT) {
            packetData = inputBuffer.slice(0, mqttHeader.totalSize);
            inputBuffer = inputBuffer.slice(mqttHeader.totalSize);
          } else {
            // Non-MQTT: treat entire incoming chunk as one packet
            packetData = inputBuffer;
            inputBuffer = Buffer.alloc(0);
          }
        } else {
          // MQTT session but can't parse header — probably incomplete, wait for more data
          break;
        }

        process_single_packet(packetData, socket, remoteAddr);
      }

    } catch (e) {
      log('CRITICAL', `Failed processing packet: ${e.message}`);
      log('CRITICAL', e.stack);
    }
  });

  function process_single_packet(data, sock, addr) {
    const raw_str = data.toString('utf8').trim();
    const hex_str = data.toString('hex');

    // ── Always log raw bytes (console + file) ──
    log('DATA', `[${addr}] Raw string : ${raw_str.length > 300 ? raw_str.slice(0, 300) + '…' : raw_str}`);
    log('DATA', `[${addr}] HEX packet : ${hex_str.length > 140 ? hex_str.slice(0, 140) + '…' : hex_str}`);
    log('DATA', `[${addr}] Byte count : ${data.length}`);

    file_log('RECEIVED', `DTU ${addr}`, [
      `Bytes  : ${data.length}`,
      `Text   : ${raw_str.length > 200 ? raw_str.slice(0, 200) + '…' : raw_str}`,
      `HEX    : ${hex_str.slice(0, 120)}${data.length > 60 ? '…' : ''}`,
    ]);

    // ── Decode ──
    const pkt = decode_packet(data);
    log('DECODE', `TYPE=${pkt.type}  |  ${pkt.summary}`);

    if (pkt.hint) {
      log('HINT', pkt.hint);
    }

    // ── Handle each type ──
    switch (pkt.type) {

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  MQTT BINARY PROTOCOL (DTU in MQTT mode)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      case 'MQTT_CONNECT': {
        is_mqtt_session = true;
        dtu_client_id = pkt.connect.clientId;
        log('MQTT-BROKER', `✓ DTU identified as MQTT client "${dtu_client_id}" — sending CONNACK`);

        // Send CONNACK (return code 0 = Connection Accepted)
        const connack = mqtt_build_connack(0x00);
        sock.write(connack);
        log('MQTT-BROKER', `→ CONNACK sent (Connection Accepted)`);

        file_log('EVENT', 'MQTT CONNECT', [
          `Client ID : ${pkt.connect.clientId}`,
          `Username  : ${pkt.connect.username}`,
          `KeepAlive : ${pkt.connect.keepAlive}s`,
          `Protocol  : ${pkt.connect.protocolName} v${pkt.connect.protocolLevel}`,
          `Response  : CONNACK 0x00 (accepted)`,
        ]);
        break;
      }

      case 'MQTT_PUBLISH': {
        log('MQTT-BROKER', `◆ PUBLISH received  →  topic="${pkt.topic}"  qos=${pkt.qos}  payload="${pkt.payload.length > 100 ? pkt.payload.slice(0, 100) + '…' : pkt.payload}"`);

        // Send PUBACK for QoS 1
        if (pkt.respond === 'PUBACK' && pkt.packetId) {
          const puback = mqtt_build_puback(pkt.packetId);
          sock.write(puback);
          log('MQTT-BROKER', `→ PUBACK sent (packetId=${pkt.packetId})`);
        }

        // Save topic for reference
        if (pkt.topic) registered_topic = pkt.topic;

        // ── Forward sensor data ──
        if (pkt.json_payload) {
          extract_and_forward(pkt.json_payload, pkt.topic);
        } else if (pkt.payload && pkt.payload.trim().length > 0) {
          // Non-JSON payload — try to parse as sensorDatas format
          const sensorMatch = pkt.payload.match(/sensorDatas:\s*(\[.*\])/);
          if (sensorMatch) {
            try {
              const readings = JSON.parse(sensorMatch[1]);
              extract_and_forward({ sensorDatas: readings }, pkt.topic);
            } catch (_) {
              log('DATA', `[MQTT PUB, non-JSON] Forwarding raw payload: "${pkt.payload}"`);
              publish_mqtt(pkt.payload, pkt.topic || cfg.publish_topic);
            }
          } else {
            log('DATA', `[MQTT PUB, raw] Forwarding payload: "${pkt.payload}"`);
            publish_mqtt(pkt.payload, pkt.topic || cfg.publish_topic);
          }
        }

        file_log('EVENT', 'MQTT PUBLISH', [
          `Topic     : ${pkt.topic}`,
          `QoS       : ${pkt.qos}`,
          `PacketId  : ${pkt.packetId}`,
          `Payload   : ${pkt.payload}`,
        ]);
        break;
      }

      case 'MQTT_SUBSCRIBE': {
        log('MQTT-BROKER', `◆ SUBSCRIBE received — topics: ${pkt.subscribe.topics.map(t => t.topic).join(', ')}`);

        // Grant all requested QoS levels
        const grantedQos = pkt.subscribe.topics.map(t => t.qos);
        const suback = mqtt_build_suback(pkt.subscribe.packetId, grantedQos);
        sock.write(suback);
        log('MQTT-BROKER', `→ SUBACK sent (packetId=${pkt.subscribe.packetId}, granted=[${grantedQos.join(',')}])`);

        // Record subscribed topics
        if (pkt.subscribe.topics.length > 0) {
          registered_topic = pkt.subscribe.topics[0].topic;
        }
        break;
      }

      case 'MQTT_PINGREQ': {
        const pingresp = mqtt_build_pingresp();
        sock.write(pingresp);
        log('MQTT-BROKER', `→ PINGRESP sent (DTU keepalive acknowledged)`);
        break;
      }

      case 'MQTT_DISCONNECT': {
        log('MQTT-BROKER', `DTU "${dtu_client_id}" disconnected cleanly`);
        sock.end();
        break;
      }

      case 'MQTT_PUBACK': {
        dbg(`DTU acknowledged our publish (packetId=${pkt.summary})`);
        break;
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  TRANSPARENT MODE PACKETS (DTU in 透传 mode)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      case 'HEARTBEAT':
        log('INFO', 'Heartbeat received — DTU is alive. No data to forward.');
        break;

      case 'MQTT_TEXT_LOGIN':
        registered_topic = pkt.topic;
        log('INFO', `DTU registered topic: "${pkt.topic}" — waiting for data packets.`);
        break;

      case 'MQTT_TEXT_PUB':
        if (pkt.json_payload) {
          extract_and_forward(pkt.json_payload, pkt.topic || registered_topic);
        } else {
          log('DATA', `[Text PUB, no JSON] Forwarding raw payload: "${pkt.payload}"`);
          publish_mqtt(pkt.payload, pkt.topic || registered_topic || cfg.publish_topic);
        }
        break;

      case 'JSON': {
        if (pkt.parse_error) {
          log('WARN', `JSON malformed (${pkt.parse_error}) — forwarding raw string.`);
          publish_mqtt(pkt.raw_json);
          break;
        }
        extract_and_forward(pkt.parsed, registered_topic);
        break;
      }

      case 'MODBUS':
        log('WARN', `Modbus frame received but Modbus decoding is not yet enabled.`);
        log('HINT', `Check config.json for a future "modbus_decoding" option, or contact support.`);
        break;

      case 'UNKNOWN':
      default:
        log('WARN', `Unknown packet — cannot forward. Full hex: ${data.toString('hex')}`);
        if (cfg.forward_all_raw_data && raw_str.length > 0) {
          log('DATA', `[FORWARDING RAW] forward_all_raw_data=true — sending as-is.`);
          publish_mqtt(raw_str);
        } else {
          log('DATA', `[NOT FORWARDED] Set forward_all_raw_data=true in config to force-forward unknowns.`);
        }
        break;
    }
  }

  socket.on('end',   ()    => { if (has_data || DEBUG) log('INFO', `[${remoteAddr}] disconnected (client="${dtu_client_id || 'unknown'}")`); });
  socket.on('error', (err) => { if (err.code !== 'ECONNRESET') log('ERROR', `Socket: ${err.message}`); });
});

tcp_server.listen(open_port, '0.0.0.0', () => {
  log('INFO', `Cloud DTU TCP Gateway (MQTT Broker Mode) running on Port ${open_port}. Waiting for DTU to connect...`);
});
