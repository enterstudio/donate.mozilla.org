var server = require('../server')();

// lol.
async function start() {
  server = await server();

  await server.start();
  await server.stop();
}

start();
