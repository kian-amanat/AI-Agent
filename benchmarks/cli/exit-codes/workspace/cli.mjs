const name = process.argv[2];

if (!name) {
  // BUG: reports the problem but still exits 0.
  console.log("usage: greet <name>");
} else {
  console.log(`hello, ${name}`);
}
