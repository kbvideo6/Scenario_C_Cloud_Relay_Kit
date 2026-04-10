const mqtt_library = require('mqtt');
const file_reader = require('fs');
const path_tool = require('path');
const net = require('net');

// ─── Load Config ──────────────────────────────────────────────────────────────
const setup_file_location = path_tool.join(process.cwd(), 'config.json');
let cfg;
try {
  cfg = JSON.parse(file_reader.readFileSync(setup_file_location, 'utf8'));
} catch (e) {
  console.error("Failed to read config.json", e);
  process.exit(1);
}

const DEBUG = cfg.debug_logging === true;
const log   = (tag, msg) => console.log(`[${tag}] ${msg}`);
const dbg   = (msg)      => { if (DEBUG) log('DEBUG', msg); };

// ─── 1. MQTT Forwarding Agent (LakeLedger TLS) ────────────────────────────────
const mqtt_opts = {
  username:        cfg.username,
  password:        cfg.password,
  rejectUnauthorized: true,
  clientId:        'lakeledger-bridge-' + Math.random().toString(16).slice(2, 8),
  clean:           true,
  reconnectPeriod: 5000,
};

const ca_path = path_tool.join(process.cwd(), '..', '2_TLS_Certificate', 'lakeledger-ca.crt');
if (file_reader.existsSync(ca_path)) {
  mqtt_opts.ca = file_reader.readFileSync(ca_path);
}

const mqtt_client = mqtt_library.connect(cfg.remote_broker || 'mqtts://mqtt.getlakeledger.com:8883', mqtt_opts);
mqtt_client.on('connect', () => log('MQTT',  'Securely connected to LakeLedger broker!'));
mqtt_client.on('error',   (e) => log('ERROR', `LakeLedger MQTT issue: ${e.message}`));

function publish_mqtt(payload_str) {
  mqtt_client.publish(cfg.publish_topic, payload_str, { qos: 1 }, (err) => {
    if (err) log('ERROR', `MQTT publish failed: ${err.message}`);
    else     log('SUCCESS', `LakeLedger MQTT  <-  ${payload_str}`);
  });
}

// ─── 2. Developer TCP Bridge Forwarder (134.122.14.249:8884, CSV) ─────────────
const dev_tcp_cfg = cfg.developer_tcp_bridge;

function forward_csv_to_dev_bridge(do_val, temp_val, sat_val) {
  if (!dev_tcp_cfg || !dev_tcp_cfg.enabled) {
    dbg('Developer TCP bridge disabled in config. Skipping CSV forward.');
    return;
  }

  const lake_id   = cfg.lake_id   || 'unknown_lake';
  const sensor_id = cfg.sensor_id || 'unknown_sensor';
  const csv_line  = `${lake_id},${sensor_id},${do_val},${temp_val},${sat_val}\n`;

  dbg(`Connecting to developer TCP bridge ${dev_tcp_cfg.host}:${dev_tcp_cfg.port} ...`);
  const dev_sock = new net.Socket();
  dev_sock.connect(dev_tcp_cfg.port, dev_tcp_cfg.host, () => {
    dev_sock.write(csv_line);
    log('SUCCESS', `Developer TCP Bridge  <-  ${csv_line.trim()}`);
    dev_sock.destroy();
  });
  dev_sock.on('error', (err) => log('ERROR', `Developer TCP bridge connection failed: ${err.message}`));
}

// ─── 3. DTU Raw TCP Receiver (Port 3000) ──────────────────────────────────────
const open_port = cfg.local_http_port || 3000;

const tcp_server = net.createServer((socket) => {
  dbg(`New DTU connection from [${socket.remoteAddress}]`);
  let has_data = false;

  socket.on('data', (data) => {
    try {
      has_data = true;
      const raw_str = data.toString('utf8').trim();

      // Block ALL HTTP traffic and attack probes — DTU never sends HTTP
      const HTTP_VERBS = ['GET ', 'POST ', 'PUT ', 'DELETE ', 'HEAD ', 'OPTIONS ', 'PATCH '];
      const is_http = HTTP_VERBS.some(v => raw_str.startsWith(v));
      if (is_http || raw_str.includes('HTTP/') || raw_str.includes('jsonrpc') || raw_str.includes('winnt')) {
        dbg(`[SECURITY] Blocked HTTP/attack probe from [${socket.remoteAddress}]: ${raw_str.substring(0, 60)}...`);
        socket.destroy(); // Don't even respond — starve the scanner
        return;
      }

      // ── ALWAYS log every packet's content ──
      log('DATA', `[${socket.remoteAddress}] Raw string : ${raw_str}`);
      log('DATA', `[${socket.remoteAddress}] HEX packet : ${data.toString('hex')}`);
      log('DATA', `[${socket.remoteAddress}] Byte count : ${data.length}`);

      // ── Try to extract JSON ──
      const json_start = raw_str.indexOf('{');
      if (json_start !== -1) {
        const json_str = raw_str.substring(json_start);
        let parsed;

        try {
          parsed = JSON.parse(json_str);
        } catch (e) {
          log('WARN', `JSON parse failed — forwarding raw JSON string as-is to MQTT.`);
          log('DATA', `[PAYLOAD TO MQTT] ${json_str}`);
          publish_mqtt(json_str);
          return;
        }

        const readings = parsed.sensorDatas || parsed.sensorData || [];
        let do_val   = 0;
        let temp_val = 0;
        let sat_val  = '';
        let mqtt_payload;

        if (readings.length >= 1) {
          do_val   = parseFloat(readings[0].value || 0);
          temp_val = readings.length > 1 ? parseFloat(readings[1].value || 0) : 0.0;
          sat_val  = readings.length > 2 ? parseFloat(readings[2].value || 0) : '';
          mqtt_payload = JSON.stringify({ dissolved_oxygen: do_val, water_temp: temp_val });
        } else {
          mqtt_payload = JSON.stringify(parsed);
        }

        // Forward to both destinations — show payload on terminal
        log('DATA', `[PARSED] DO=${do_val} | Temp=${temp_val} | Sat=${sat_val}`);
        log('DATA', `[PAYLOAD TO MQTT] ${mqtt_payload}`);
        publish_mqtt(mqtt_payload);
        forward_csv_to_dev_bridge(do_val, temp_val, sat_val);

      } else {
        // No JSON — handle raw/heartbeat packets
        log('DATA', `[NO JSON] Raw packet content: "${raw_str}"`);
        if (cfg.forward_all_raw_data && raw_str.length > 0) {
          log('DATA', `[FORWARDING RAW] Sending raw payload to MQTT and Dev Bridge`);
          publish_mqtt(raw_str);
          if (dev_tcp_cfg && dev_tcp_cfg.enabled) {
            forward_csv_to_dev_bridge(raw_str, '', '');
          }
        } else {
          log('DATA', `[NOT FORWARDED] forward_all_raw_data is false — packet logged but not sent`);
        }
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
