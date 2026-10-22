// Optional loopback-only inbox for exercising registration. No real email is sent.
import { createServer } from "node:net";
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  socket.write("220 localhost PluHub demo SMTP\r\n");
  let buffer = "",
    inData = false,
    message = "",
    recipient = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const at = buffer.indexOf("\r\n"),
        line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (inData) {
        if (line !== ".") {
          message += line + "\r\n";
          continue;
        }
        inData = false;
        const body = message.slice(message.indexOf("\r\n\r\n") + 4);
        const text = /Content-Transfer-Encoding: base64/i.test(message)
          ? Buffer.from(body, "base64").toString("utf8")
          : Buffer.from(
              body
                .replace(/=\r\n/g, "")
                .replace(/=([0-9A-F]{2})/gi, (_, h) =>
                  String.fromCharCode(parseInt(h, 16)),
                ),
              "latin1",
            ).toString("utf8");
        console.log(
          "Local demo inbox " +
            recipient +
            ": " +
            (text.match(/\b\d{6}\b/)?.[0] ?? "test message received"),
        );
        socket.write("250 demo accepted\r\n");
      } else if (/^EHLO|^HELO/.test(line))
        socket.write("250-localhost\r\n250 SIZE 100000\r\n");
      else if (/^RCPT TO:/i.test(line)) {
        recipient = line.slice(8).trim();
        socket.write(
          /@example\.test>/i.test(recipient)
            ? "250 ok\r\n"
            : "550 use an example.test address for this local demo\r\n",
        );
      } else if (line === "DATA") {
        message = "";
        inData = true;
        socket.write("354 end with dot\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.PLUHUB_DEMO_SMTP_PORT = String(server.address().port);
process.env.PLUHUB_DEMO_IDENTITY = "1";
console.log(
  "Identity demo uses localhost and a synthetic inbox; use addresses ending in @example.test. OTPs appear only in this terminal.",
);
function close() {
  for (const socket of sockets) socket.destroy();
  server.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
try {
  await import("./demo.mjs");
} catch (error) {
  close();
  throw error;
}
