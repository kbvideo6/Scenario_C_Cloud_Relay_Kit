const mqtt_library = require('mqtt');
const file_reader = require('fs');
const path_tool = require('path');

const setup_file_location = path_tool.join(process.cwd(), 'config.json');
let active_network_settings;
try {
  active_network_settings = JSON.parse(file_reader.readFileSync(setup_file_location, 'utf8'));
} catch (failure_reason) {
  console.error("Failed to read config.json", failure_reason);
  process.exit(1);
}

// 1. Setup Forwarding Agent (To LakeLedger)
const connection_rules = {
  username: active_network_settings.username,
  password: active_network_settings.password,
  rejectUnauthorized: true,
  clientId: 'lakeledger-bridge-pub-' + Math.random().toString(16).slice(2, 8),
  clean: true,
  reconnectPeriod: 5000,
};

const custom_security_certificate = path_tool.join(process.cwd(), '..', '2_TLS_Certificate', 'lakeledger-ca.crt');
if (file_reader.existsSync(custom_security_certificate)) {
  connection_rules.ca = file_reader.readFileSync(custom_security_certificate);
} 

const bridge_client = mqtt_library.connect(active_network_settings.remote_broker || "mqtts://mqtt.getlakeledger.com:8883", connection_rules);

bridge_client.on('connect', () => {
  console.log(`Bridge is securely connected to the main LakeLedger broker!`);
});

bridge_client.on('error', (failure_reason) => {
  console.error('Connection issue found with LakeLedger: ', failure_reason.message);
});

const net = require('net');

// 2. Setup Local Receiving Agent (Custom Raw TCP Gateway)
const open_port = active_network_settings.local_http_port || 3000;

const tcp_server = net.createServer((socket) => {
  if (active_network_settings.debug_logging) {
    console.log(`[DEBUG] New connection established from [${socket.remoteAddress}]`);
  }

  let has_received_data = false;

  socket.on('data', (data) => {
    try {
      has_received_data = true;
      const raw_str = data.toString('utf8').trim();
      
      // Ignore Render's HTTP health checks to stop log spam
      if (raw_str.startsWith('GET /') || raw_str.startsWith('HEAD /')) {
        socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
        socket.end();
        return;
      }

      if (active_network_settings.debug_logging) {
        console.log(`[DEBUG] [${socket.remoteAddress}] Received raw packet: ${raw_str}`);
      } else {
        console.log(`[${socket.remoteAddress}] Received data: ${raw_str}`);
      }

      // Extract JSON part from proprietary wrapped string
      // e.g. "PUB lake/.../data {"sensorDatas":[{"value":0.165}]}"
      const start_idx = raw_str.indexOf('{');
      if (start_idx !== -1) {
        let json_str = raw_str.substring(start_idx);
        let converted_packet;
        
        try {
          converted_packet = JSON.parse(json_str);
        } catch (e) {
          if (active_network_settings.debug_logging) console.log(`[DEBUG] Parsing JSON failed. Forwarding raw json payload string.`);
          bridge_client.publish(active_network_settings.publish_topic, json_str, { qos: 1 });
          return;
        }

        const sensor_values_list = converted_packet.sensorDatas || converted_packet.sensorData || [];
        let final_JSON_string;

        // Structured wrapper format handler
        if (sensor_values_list.length >= 1) {
          const clean_river_readings = {
            dissolved_oxygen: parseFloat(sensor_values_list[0].value || 0),
            water_temp: sensor_values_list.length > 1 ? parseFloat(sensor_values_list[1].value || 0) : 0.0
          };
          final_JSON_string = JSON.stringify(clean_river_readings);
        } else {
          final_JSON_string = JSON.stringify(converted_packet);
        }

        bridge_client.publish(active_network_settings.publish_topic, final_JSON_string, { qos: 1 }, (failure_reason) => {
          if (failure_reason) {
            console.error('[ERROR] Publish drop', failure_reason);
          } else {
            console.log(`[SUCCESS] Forwarded formatted JSON safely to LakeLedger -> `, final_JSON_string);
          }
        });
      } else {
        // No JSON found handler
        if (active_network_settings.forward_all_raw_data) {
          if (active_network_settings.debug_logging) console.log(`[DEBUG] No JSON found in packet. "forward_all_raw_data" is enabled, forwarding raw payload to MQTT.`);
          
          if (raw_str.length > 0) {
            bridge_client.publish(active_network_settings.publish_topic, raw_str, { qos: 1 }, (failure_reason) => {
              if (failure_reason) {
                console.error('[ERROR] Publish drop on raw data', failure_reason);
              } else {
                console.log(`[SUCCESS] Forwarded raw packet safely to LakeLedger -> `, raw_str);
              }
            });
          }
        } else {
          if (active_network_settings.debug_logging) console.log(`[DEBUG] packet ignored (no JSON '{' found and 'forward_all_raw_data' is false)`);
        }
      }
    } catch (failure_reason) {
      console.error('[CRITICAL] Failed processing packet', failure_reason);
    }
  });

  socket.on('end', () => {
    // Only log disconnect if we actually exchanged data or in debug mode
    if (has_received_data || active_network_settings.debug_logging) {
      console.log(`[${socket.remoteAddress}] disconnected`);
    }
  });

  socket.on('error', (err) => {
    // Suppress simple connection reset errors from health checkers
    if (err.code !== 'ECONNRESET') {
      console.error('Socket error: ', err.message);
    }
  });
});

tcp_server.listen(open_port, '0.0.0.0', () => {
  console.log(`Cloud DTU TCP Gateway running on Port ${open_port}. Waiting for DTU to connect...`);
});

