// Server-Sent Events service for frontend telemetry

class SSEService {
  constructor() {
    this.clients = new Set();
    this.setupPingInterval();
  }

  // Add a client to the SSE broadcast list
  addClient(response) {
    this.clients.add(response);
    response.on('close', () => {
      this.clients.delete(response);
    });
  }

  // Broadcast an event to all connected clients
  broadcast(event, data) {
    const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { 
        res.write(payload); 
      } catch (_) {
        // Remove failed clients
        this.clients.delete(res);
      }
    }
  }

  // Setup periodic ping to keep connections alive
  setupPingInterval() {
    setInterval(() => {
      for (const res of this.clients) {
        try { 
          res.write(`: ping\n\n`); 
        } catch (_) {
          // Remove failed clients
          this.clients.delete(res);
        }
      }
    }, 25000);
  }

  // Get the number of connected clients
  getClientCount() {
    return this.clients.size;
  }

  // Close all connections
  closeAll() {
    for (const res of this.clients) {
      try {
        res.end();
      } catch (_) {}
    }
    this.clients.clear();
  }
}

// Export singleton instance
module.exports = new SSEService();
