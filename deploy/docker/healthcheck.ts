try {
  const response = await fetch("http://127.0.0.1:8080/readyz", {
    signal: AbortSignal.timeout(4000),
  });
  process.exitCode = response.ok ? 0 : 1;
  await response.body?.cancel();
} catch {
  process.exitCode = 1;
}
