// LocalPlayer Backend Server
// Deployed on Render with PostgreSQL

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// PostgreSQL connection with YOUR credentials
const pool = new Pool({
  host: 'dpg-d66uphi48b3s73d0s8f0-a.frankfurt-postgres.render.com',
  port: 5432,
  database: 'localplayersql',
  user: 'localplayer',
  password: 'nIUc6Rv5m9UaiDifqwPFWfLqpZb19zHd',
  ssl: {
    rejectUnauthorized: false
  }
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to database:', err);
  } else {
    console.log('✅ Connected to PostgreSQL database');
    release();
  }
});

// Initialize database tables
async function initDB() {
  const client = await pool.connect();
  try {
    // Networks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS networks (
        uuid VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        host_device_id VARCHAR(255) NOT NULL,
        host_ip VARCHAR(50),
        is_private BOOLEAN DEFAULT false,
        password VARCHAR(255),
        port INTEGER DEFAULT 25565,
        max_players INTEGER DEFAULT 10,
        server_running BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW(),
        last_active TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Connected devices table
    await client.query(`
      CREATE TABLE IF NOT EXISTS connected_devices (
        id SERIAL PRIMARY KEY,
        network_uuid VARCHAR(255) REFERENCES networks(uuid) ON DELETE CASCADE,
        device_id VARCHAR(255) NOT NULL,
        device_name VARCHAR(255),
        device_model VARCHAR(255),
        ip_address VARCHAR(50),
        vpn_ip VARCHAR(50),
        connected_at TIMESTAMP DEFAULT NOW(),
        last_heartbeat TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT true,
        UNIQUE(network_uuid, device_id)
      )
    `);
    
    console.log('✅ Database tables created/verified');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
  } finally {
    client.release();
  }
}

initDB();

// Store WebSocket connections
const connections = new Map(); // device_id -> { ws, networkUuid, deviceInfo }

// WebSocket handler
wss.on('connection', (ws, req) => {
  let deviceId = null;
  let currentNetwork = null;
  
  const clientIp = req.socket.remoteAddress;
  console.log(`📱 New connection from ${clientIp}`);
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📩 Received: ${data.type} from ${deviceId || 'unknown'}`);
      
      switch (data.type) {
        case 'register':
          deviceId = data.deviceId;
          connections.set(deviceId, { 
            ws, 
            networkUuid: null,
            deviceInfo: data.deviceInfo || {}
          });
          console.log(`✅ Device registered: ${deviceId}`);
          ws.send(JSON.stringify({ 
            type: 'registered', 
            deviceId,
            message: 'Connected to LocalPlayer server'
          }));
          break;
          
        case 'create_network':
          currentNetwork = await handleCreateNetwork(data, deviceId, clientIp, ws);
          break;
          
        case 'join_network':
          currentNetwork = await handleJoinNetwork(data, deviceId, clientIp, ws);
          break;
          
        case 'leave_network':
          await handleLeaveNetwork(currentNetwork, deviceId);
          currentNetwork = null;
          break;
          
        case 'update_server_status':
          await handleUpdateServerStatus(data, deviceId);
          break;
          
        case 'get_network_devices':
          await handleGetNetworkDevices(data.uuid, ws);
          break;
          
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          forwardToPeer(data, deviceId);
          break;
          
        case 'heartbeat':
          await handleHeartbeat(currentNetwork, deviceId);
          ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
          break;
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: error.message 
      }));
    }
  });
  
  ws.on('close', async () => {
    console.log(`📴 Device disconnected: ${deviceId}`);
    if (deviceId) {
      connections.delete(deviceId);
      if (currentNetwork) {
        await handleLeaveNetwork(currentNetwork, deviceId);
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

async function handleCreateNetwork(data, deviceId, clientIp, ws) {
  const client = await pool.connect();
  try {
    const { uuid, name, isPrivate, password, port, maxPlayers } = data;
    
    // Insert network
    await client.query(
      `INSERT INTO networks (uuid, name, host_device_id, host_ip, is_private, password, port, max_players) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (uuid) DO UPDATE SET 
         last_active = NOW(),
         host_ip = $4`,
      [uuid, name, deviceId, clientIp, isPrivate, password, port, maxPlayers]
    );
    
    // Add host as connected device
    await client.query(
      `INSERT INTO connected_devices (network_uuid, device_id, device_name, ip_address, vpn_ip, is_active) 
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (network_uuid, device_id) DO UPDATE SET 
         is_active = true,
         last_heartbeat = NOW()`,
      [uuid, deviceId, 'Host', clientIp, '10.0.0.2']
    );
    
    // Update connection info
    if (connections.has(deviceId)) {
      connections.get(deviceId).networkUuid = uuid;
    }
    
    ws.send(JSON.stringify({ 
      type: 'network_created', 
      uuid,
      message: 'Сеть успешно создана!'
    }));
    
    console.log(`🌐 Network created: ${name} (${uuid}) by ${deviceId}`);
    return uuid;
    
  } finally {
    client.release();
  }
}

async function handleJoinNetwork(data, deviceId, clientIp, ws) {
  const client = await pool.connect();
  try {
    const { uuid, password } = data;
    
    // Get network info
    const result = await client.query(
      'SELECT * FROM networks WHERE uuid = $1',
      [uuid]
    );
    
    if (result.rows.length === 0) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Сеть не найдена' 
      }));
      return null;
    }
    
    const network = result.rows[0];
    
    // Check password
    if (network.is_private && network.password !== password) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Неверный пароль' 
      }));
      return null;
    }
    
    // Get next VPN IP
    const devicesResult = await client.query(
      'SELECT COUNT(*) as count FROM connected_devices WHERE network_uuid = $1 AND is_active = true',
      [uuid]
    );
    const deviceCount = parseInt(devicesResult.rows[0].count);
    const vpnIp = `10.0.0.${deviceCount + 2}`;
    
    // Add device
    await client.query(
      `INSERT INTO connected_devices (network_uuid, device_id, device_name, ip_address, vpn_ip, is_active) 
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (network_uuid, device_id) DO UPDATE SET 
         is_active = true,
         vpn_ip = $5,
         last_heartbeat = NOW()`,
      [uuid, deviceId, 'Player', clientIp, vpnIp]
    );
    
    // Update last active
    await client.query(
      'UPDATE networks SET last_active = NOW() WHERE uuid = $1',
      [uuid]
    );
    
    // Update connection info
    if (connections.has(deviceId)) {
      connections.get(deviceId).networkUuid = uuid;
    }
    
    // Get all devices in network
    const devicesInNetwork = await client.query(
      'SELECT device_id, device_name, vpn_ip FROM connected_devices WHERE network_uuid = $1 AND is_active = true',
      [uuid]
    );
    
    // Notify all peers
    notifyNetworkPeers(uuid, {
      type: 'peer_joined',
      peerId: deviceId,
      vpnIp: vpnIp
    }, deviceId);
    
    ws.send(JSON.stringify({ 
      type: 'network_joined', 
      uuid,
      network: network,
      vpnIp: vpnIp,
      devices: devicesInNetwork.rows,
      message: 'Успешно подключено к сети!'
    }));
    
    console.log(`👥 Device ${deviceId} joined network ${uuid} with IP ${vpnIp}`);
    return uuid;
    
  } finally {
    client.release();
  }
}

async function handleLeaveNetwork(uuid, deviceId) {
  if (!uuid || !deviceId) return;
  
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE connected_devices SET is_active = false WHERE network_uuid = $1 AND device_id = $2',
      [uuid, deviceId]
    );
    
    // Notify others
    notifyNetworkPeers(uuid, {
      type: 'peer_left',
      peerId: deviceId
    }, deviceId);
    
    console.log(`👋 Device ${deviceId} left network ${uuid}`);
  } finally {
    client.release();
  }
}

async function handleUpdateServerStatus(data, deviceId) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE networks SET server_running = $1 WHERE host_device_id = $2',
      [data.isRunning, deviceId]
    );
  } finally {
    client.release();
  }
}

async function handleGetNetworkDevices(uuid, ws) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT device_id, device_name, device_model, vpn_ip, connected_at, is_active FROM connected_devices WHERE network_uuid = $1 ORDER BY connected_at',
      [uuid]
    );
    
    ws.send(JSON.stringify({
      type: 'network_devices',
      devices: result.rows
    }));
  } finally {
    client.release();
  }
}

async function handleHeartbeat(uuid, deviceId) {
  if (!uuid || !deviceId) return;
  
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE connected_devices SET last_heartbeat = NOW() WHERE network_uuid = $1 AND device_id = $2',
      [uuid, deviceId]
    );
  } finally {
    client.release();
  }
}

function forwardToPeer(data, fromDeviceId) {
  const toDeviceId = data.to;
  const connection = connections.get(toDeviceId);
  
  if (connection && connection.ws.readyState === WebSocket.OPEN) {
    connection.ws.send(JSON.stringify({
      ...data,
      from: fromDeviceId
    }));
  }
}

function notifyNetworkPeers(networkUuid, message, excludeDeviceId = null) {
  connections.forEach((conn, deviceId) => {
    if (conn.networkUuid === networkUuid && 
        deviceId !== excludeDeviceId && 
        conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(message));
    }
  });
}

// REST API endpoints
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    connections: connections.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/stats', async (req, res) => {
  const client = await pool.connect();
  try {
    const networks = await client.query('SELECT COUNT(*) FROM networks');
    const devices = await client.query('SELECT COUNT(*) FROM connected_devices WHERE is_active = true');
    
    res.json({
      total_networks: parseInt(networks.rows[0].count),
      active_devices: parseInt(devices.rows[0].count),
      active_connections: connections.size
    });
  } finally {
    client.release();
  }
});

app.get('/networks/:uuid', async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM networks WHERE uuid = $1',
      [req.params.uuid]
    );
    
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Network not found' });
    } else {
      res.json(result.rows[0]);
    }
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   LocalPlayer Server Started! 🚀       ║
╠════════════════════════════════════════╣
║   Port: ${PORT}                         ║
║   Database: Connected ✅                ║
║   WebSocket: Ready ✅                   ║
╚════════════════════════════════════════╝
  `);
});

// Cleanup inactive devices every minute
setInterval(async () => {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE connected_devices SET is_active = false 
       WHERE last_heartbeat < NOW() - INTERVAL '2 minutes'`
    );
  } finally {
    client.release();
  }
}, 60000);
