const expectedMajor = 24;
const actualMajor = Number.parseInt(process.versions.node.split(".", 1)[0], 10);

if (actualMajor !== expectedMajor) {
  console.error(`LLM Proxy requires Node.js ${expectedMajor}.x; current runtime is ${process.version}.`);
  process.exitCode = 1;
} else {
  console.log(`Node.js runtime OK: ${process.version}`);
}

