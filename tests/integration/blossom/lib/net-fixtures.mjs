import http from "node:http";
import net from "node:net";

/**
 * Loopback HTTP origin the proxy fetches from. `GET /bytes/<n>` returns n
 * bytes, so the amount of traffic the proxy must account for is known.
 */
export function startOrigin() {
  const server = http.createServer((req, res) => {
    const match = /^\/bytes\/(\d+)$/.exec(req.url ?? "");
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const size = Number(match[1]);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
    });
    res.end(Buffer.alloc(size, 0x61));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Occupies a port on every interface (dual stack) so a sing-box inbound that
 * wants it fails to bind. Used to provoke a start-time failure after the
 * config itself passed `sing-box check`.
 */
export async function occupyPort() {
  const ipv4 = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    ipv4.once("error", reject);
    ipv4.listen(0, "0.0.0.0", resolve);
  });
  const port = ipv4.address().port;
  const ipv6 = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      ipv6.once("error", reject);
      ipv6.listen({ port, host: "::", ipv6Only: true }, resolve);
    });
  } catch (error) {
    await new Promise((resolve) => ipv4.close(resolve));
    throw error;
  }
  return {
    port,
    close: () => Promise.all([ipv4, ipv6].map((server) =>
      new Promise((resolve) => server.close(resolve)),
    )),
  };
}
