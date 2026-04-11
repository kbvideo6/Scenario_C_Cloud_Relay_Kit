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

const DEBUG = cfg.debug_logging === true;

// ─── Session Log File ─────────────────────────────────────────────────────────
// One .txt file per run, saved to ./logs/  — safe to delete anytime.
const log_dir = path_tool.join(process.cwd(), 'logs');
if (!file_reader.existsSync(log_dir)) file_reader.mkdirSync(log_dir, { recursive: true });

const session_start   = new Date();
const session_stamp   = session_start.toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
const log_file_path   = path_tool.join(log_dir, `bridge_log_${session_stamp}.txt`);
const log_file_stream = file_reader.createWriteStream(log_file_path, { flags: 'a' });

// Write a line to both console and the session log file
function write_log_line(line) {
  console.log(line);
  log_file_stream.write(line + os.EOL);
}

// Tagged log — mirrors what we had before, but also goes to file
const log = (tag, msg) => write_log_line(`[${tag}] ${msg}`);
const dbg = (msg)      => { if (DEBUG) log('DEBUG', msg); };

// Called once on startup
write_log_line('═'.repeat(60));
write_log_line(`  Bridge Session Started : ${session_start.toISOString()}`);
write_log_line(`  Log file              : ${log_file_path}`);
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

// ─── 3. Packet Decoder ────────────────────────────────────────────────────────
/**
 * Classifies every raw packet the DTU sends and returns a structured result.
 *
 * Known packet types
 * ──────────────────
 *  HEARTBEAT   — single byte 0x30 or ASCII "0" / "Q"
 *  MQTT_PUB    — raw MQTT PUBLISH frame: "PUB <topic> <payload>" or binary 0x30+length+topic
 *  JSON        — packet that contains a {...} JSON object
 *  MODBUS      — binary frame starting with a valid Modbus RTU signature
 *  UNKNOWN     — anything else (still logged in full)
 */
function decode_packet(data) {
  const raw_str   = data.toString('utf8');
  const trimmed   = raw_str.trim();
  const hex       = data.toString('hex');
  const byte0     = data[0];

  // ── HEARTBEAT ──────────────────────────────────────────────────────────────
  // Single-byte 0x30 (ASCII "0"), single byte 0x51 ("Q"), or the literal string "0"
  if (data.length <= 2 && (trimmed === '0' || trimmed === 'Q' || byte0 === 0x30)) {
    return {
      type:    'HEARTBEAT',
      summary: `Heartbeat packet (raw: "${trimmed}", hex: ${hex})`,
      forward: false,
    };
  }

  // ── PLAIN TEXT "PUB <topic>" — some DTU firmware sends this ────────────────
  if (trimmed.startsWith('PUB ')) {
    const parts   = trimmed.slice(4).split(' '); // skip "PUB "
    const topic   = parts[0] || '';
    const payload = parts.slice(1).join(' ').trim();

    // If there is no space after the topic the whole remainder IS the topic (login-only frame)
    if (!payload) {
      return {
        type:    'MQTT_LOGIN',
        summary: `DTU Topic Registration  →  Topic: "${topic}"`,
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
      type:         'MQTT_PUB',
      summary:      `MQTT PUB  →  topic="${topic}"  payload="${payload}"`,
      topic,
      payload,
      json_payload,
      forward:      true,
    };
  }

  // ── BINARY MQTT PUBLISH FRAME  (0x30 command byte + variable length) ────────
  // Real MQTT PUBLISH: byte[0]=0x30, byte[1]=remaining_length, then topic_len(2 bytes)+topic+payload
  if (byte0 === 0x30 && data.length > 4) {
    try {
      const remaining = data[1];           // remaining bytes after header
      if (remaining === data.length - 2) { // sanity check
        const topic_len = (data[2] << 8) | data[3];
        const topic     = data.slice(4, 4 + topic_len).toString('utf8');
        const payload   = data.slice(4 + topic_len).toString('utf8');

        let json_payload = null;
        try { json_payload = JSON.parse(payload); } catch (_) {}

        return {
          type:         'MQTT_BINARY_PUB',
          summary:      `Binary MQTT PUB  →  topic="${topic}"  payload="${payload}"`,
          topic,
          payload,
          json_payload,
          forward:      true,
        };
      }
    } catch (_) {}
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

// ─── 4. DTU Raw TCP Receiver (Port 3000) ──────────────────────────────────────
const open_port = cfg.local_http_port || 3000;

const tcp_server = net.createServer((socket) => {
  log('INFO', `New DTU connection from [${socket.remoteAddress}]`);
  let has_data = false;

  socket.on('data', (data) => {
    try {
      has_data = true;

      // ── Quick security filter — DTU never sends HTTP ──
      const raw_str = data.toString('utf8').trim();
      const HTTP_VERBS = ['GET ', 'POST ', 'PUT ', 'DELETE ', 'HEAD ', 'OPTIONS ', 'PATCH '];
      if (HTTP_VERBS.some(v => raw_str.startsWith(v)) ||
          raw_str.includes('HTTP/') ||
          raw_str.includes('jsonrpc') ||
          raw_str.includes('winnt')) {
        dbg(`[SECURITY] Blocked HTTP probe from [${socket.remoteAddress}]`);
        socket.destroy();
        return;
      }

      // ── Always log raw bytes (console + file) ──
      log('DATA', `[${socket.remoteAddress}] Raw string : ${raw_str}`);
      log('DATA', `[${socket.remoteAddress}] HEX packet : ${data.toString('hex')}`);
      log('DATA', `[${socket.remoteAddress}] Byte count : ${data.length}`);

      file_log('RECEIVED', `DTU ${socket.remoteAddress}`, [
        `Bytes  : ${data.length}`,
        `Text   : ${raw_str.length > 200 ? raw_str.slice(0, 200) + '…' : raw_str}`,
        `HEX    : ${data.toString('hex').slice(0, 120)}${data.length > 60 ? '…' : ''}`,
      ]);

      // ── Decode ──
      const pkt = decode_packet(data);
      log('DECODE', `TYPE=${pkt.type}  |  ${pkt.summary}`);

      if (pkt.hint) {
        log('HINT', pkt.hint);
      }

      // ── Handle each type ──
      switch (pkt.type) {

        case 'HEARTBEAT':
          log('INFO', 'Heartbeat received — DTU is alive. No data to forward.');
          break;

        case 'MQTT_LOGIN':
          log('INFO', `DTU registered topic: "${pkt.topic}" — waiting for data packets.`);
          break;

        case 'MQTT_PUB':
        case 'MQTT_BINARY_PUB':
          if (pkt.json_payload) {
            // We got structured data — extract sensor readings
            const parsed  = pkt.json_payload;
            const readings = parsed.sensorDatas || parsed.sensorData || [];
            let do_val   = 0, temp_val = 0, sat_val = '';
            let mqtt_payload;

            if (readings.length >= 1) {
              do_val   = parseFloat(readings[0].value || 0);
              temp_val = readings.length > 1 ? parseFloat(readings[1].value || 0) : 0.0;
              sat_val  = readings.length > 2 ? parseFloat(readings[2].value || 0) : '';
              mqtt_payload = JSON.stringify({ dissolved_oxygen: do_val, water_temp: temp_val });
            } else {
              mqtt_payload = JSON.stringify(parsed);
            }

            log('DATA', `[PARSED] DO=${do_val} | Temp=${temp_val} | Sat=${sat_val}`);
            publish_mqtt(mqtt_payload, pkt.topic || cfg.publish_topic);
            forward_csv_to_dev_bridge(do_val, temp_val, sat_val);
          } else {
            // Forward the raw payload string — it may be plain sensor values
            log('DATA', `[MQTT PUB, no JSON] Forwarding raw payload: "${pkt.payload}"`);
            publish_mqtt(pkt.payload, pkt.topic || cfg.publish_topic);
          }
          break;

        case 'JSON': {
          const parsed  = pkt.parsed;
          const readings = parsed ? (parsed.sensorDatas || parsed.sensorData || []) : [];
          let do_val   = 0, temp_val = 0, sat_val = '';
          let mqtt_payload;

          if (pkt.parse_error) {
            log('WARN', `JSON malformed (${pkt.parse_error}) — forwarding raw string.`);
            publish_mqtt(pkt.raw_json);
            break;
          }

          if (readings.length >= 1) {
            do_val   = parseFloat(readings[0].value || 0);
            temp_val = readings.length > 1 ? parseFloat(readings[1].value || 0) : 0.0;
            sat_val  = readings.length > 2 ? parseFloat(readings[2].value || 0) : '';
            mqtt_payload = JSON.stringify({ dissolved_oxygen: do_val, water_temp: temp_val });
          } else {
            mqtt_payload = JSON.stringify(parsed);
          }

          log('DATA', `[PARSED] DO=${do_val} | Temp=${temp_val} | Sat=${sat_val}`);
          publish_mqtt(mqtt_payload);
          forward_csv_to_dev_bridge(do_val, temp_val, sat_val);
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

    } catch (e) {
      log('CRITICAL', `Failed processing packet: ${e.message}`);
    }
  });

  socket.on('end',   ()    => { if (has_data || DEBUG) log('INFO', `[${socket.remoteAddress}] disconnected`); });
  socket.on('error', (err) => { if (err.code !== 'ECONNRESET') log('ERROR', `Socket: ${err.message}`); });
});

tcp_server.listen(open_port, '0.0.0.0', () => {
  log('INFO', `Cloud DTU TCP Gateway running on Port ${open_port}. Waiting for DTU to connect...`);
});
