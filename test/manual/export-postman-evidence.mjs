import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , inputPath, outputPath, summaryPath, reportTitle = 'Homingo API'] =
  process.argv;
if (!inputPath || !outputPath || !summaryPath) {
  throw new Error(
    'Usage: node export-postman-evidence.mjs <newman.json> <responses.json> <summary.md> [title]',
  );
}

const source = JSON.parse(await readFile(resolve(inputPath), 'utf8'));

function decodedBody(stream) {
  if (typeof stream === 'string') return stream;
  if (stream?.type === 'Buffer' && Array.isArray(stream.data)) {
    return Buffer.from(stream.data).toString('utf8');
  }
  return '';
}

function readableBody(stream) {
  const text = decodedBody(stream);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactSecrets(value, parentKey = '') {
  const secretKeys = new Set([
    'accessToken',
    'refreshToken',
    'providerRef',
    'idToken',
    'firebaseIdToken',
    'phone',
  ]);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== 'object') {
    if (secretKeys.has(parentKey)) return '[REDACTED]';
    if (parentKey === 'code' && /^\d{4,8}$/.test(String(value))) {
      return '[REDACTED]';
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      redactSecrets(child, key),
    ]),
  );
}

function safeHeaders(headers = []) {
  const secretHeaders = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
  ]);
  return headers
    .filter((header) => !secretHeaders.has(String(header.key).toLowerCase()))
    .map(({ key, value }) => ({ key, value }));
}

const executions = (source.run?.executions ?? []).map((execution, index) => {
  const requestBody = execution.request?.body?.raw;
  let parsedRequestBody = requestBody ?? null;
  if (requestBody) {
    try {
      parsedRequestBody = JSON.parse(requestBody);
    } catch {
      // Preserve non-JSON payloads.
    }
  }

  return {
    sequence: index + 1,
    name: execution.item?.name ?? `Request ${index + 1}`,
    request: {
      method: execution.request?.method ?? null,
      url: String(execution.request?.url?.raw ?? '').replace(
        /\+?91?\d{10}/g,
        '[REDACTED_PHONE]',
      ),
      headers: safeHeaders(execution.request?.header),
      hasBody: requestBody !== undefined,
      ...(requestBody !== undefined
        ? { body: redactSecrets(parsedRequestBody) }
        : {}),
    },
    response: {
      status: execution.response?.status ?? null,
      code: execution.response?.code ?? null,
      responseTimeMs: execution.response?.responseTime ?? null,
      responseSizeBytes: execution.response?.responseSize ?? null,
      headers: safeHeaders(execution.response?.header),
      body: redactSecrets(readableBody(execution.response?.stream)),
    },
    assertions: (execution.assertions ?? []).map((assertion) => ({
      name: assertion.assertion,
      passed: !assertion.error,
      error: assertion.error?.message ?? null,
    })),
  };
});

const stats = source.run?.stats ?? {};
const evidence = {
  generatedAt: new Date().toISOString(),
  description:
    'Sanitized Newman evidence from real HTTP calls to an isolated Homingo application. Authentication secrets, OTPs, provider references, and phone numbers are removed.',
  summary: {
    requests: executions.length,
    assertions: stats.assertions?.total ?? null,
    failedAssertions: stats.assertions?.failed ?? null,
    requestStats: stats.requests ?? null,
    assertionStats: stats.assertions ?? null,
  },
  executions,
};

const rows = executions.map((execution) => {
  const failed = execution.assertions.filter((item) => !item.passed).length;
  const result = failed === 0 ? 'Pass' : `Fail (${failed})`;
  return `| ${execution.sequence} | ${execution.request.method} | ${execution.name.replaceAll('|', '\\|')} | ${execution.response.code ?? 'Skipped'} | ${execution.response.responseTimeMs ?? ''} | ${result} |`;
});

const markdown = `# ${reportTitle} Postman evidence

Generated: ${evidence.generatedAt}

These are sanitized responses captured from real HTTP calls to the isolated Homingo application. Full request and response bodies are in the adjacent JSON evidence file.

- Requests executed: ${evidence.summary.requests}
- Assertions: ${evidence.summary.assertions}
- Failed assertions: ${evidence.summary.failedAssertions}

| # | Method | Request | Status | Time (ms) | Tests |
|---:|:---:|---|---:|---:|---:|
${rows.join('\n')}
`;

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(resolve(summaryPath), markdown);
console.log(`Exported ${executions.length} sanitized responses.`);

