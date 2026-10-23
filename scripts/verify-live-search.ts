import assert from "node:assert/strict";

/** Explicit opt-in; two billable requests, asking for one hosted search. */
export async function verifyLiveSearch(options: {
  url: string;
  token: string;
  model: string;
  channel?: string;
  maxToolCalls?: number;
}) {
  const headers = {
    authorization: "Bearer " + options.token,
    "content-type": "application/json",
    ...(options.channel ? { "x-pluhub-channel": options.channel } : {}),
  };
  const checks: Record<string, unknown>[] = [];
  for (const search of [false, true]) {
    const response = await fetch(new URL("/v1/responses", options.url), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: options.model,
        stream: search,
        max_output_tokens: 128,
        reasoning: { effort: "low" },
        input: search
          ? "Use web search once to find IANA's reserved example domains. Give one short sentence and cite your source."
          : "Reply with OK only.",
        ...(search
          ? {
              tools: [{ type: "web_search" }],
              tool_choice: { type: "web_search" },
              ...(options.maxToolCalls === undefined
                ? {}
                : { max_tool_calls: options.maxToolCalls }),
            }
          : {}),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(
        `Live ${search ? "search" : "text"} request failed: ${response.status} ${error.error?.code ?? "upstream_error"}`,
      );
    }
    let result: any;
    if (!search) result = await response.json();
    else {
      const text = await response.text();
      for (const frame of text.split(/\r?\n\r?\n/)) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "response.failed" || event.type === "error")
          throw new Error("Live search stream failed");
        if (event.type === "response.completed") result = event.response;
      }
    }
    assert.equal(result?.status, "completed", "Missing successful completion");
    assert.equal(result.model, options.model);
    assert.ok(
      result.usage?.input_tokens >= 0 && result.usage?.output_tokens >= 0,
      "Missing provider usage",
    );
    const searches = result.output.filter(
      (item: any) =>
        item.type === "web_search_call" && item.status === "completed",
    ).length;
    const citations = result.output
      .flatMap((item: any) => item.content ?? [])
      .flatMap((part: any) => part.annotations ?? [])
      .filter((annotation: any) => annotation.type === "url_citation").length;
    assert.ok(
      result.output.some(
        (item: any) =>
          item.type === "message" &&
          item.content?.some((part: any) => part.text?.length),
      ),
      "Empty model answer",
    );
    if (search) {
      assert.equal(searches, 1, "Expected exactly one completed hosted search");
      assert.ok(citations > 0, "Missing search references");
    }
    checks.push({
      purpose: search ? "hosted-search-sse" : "responses-json",
      status: response.status,
      completed: true,
      searches,
      citations,
      usage: result.usage,
    });
  }
  return { model: options.model, calls: checks.length, checks };
}

if (import.meta.main) {
  const {
    PLUHUB_LIVE_URL: url,
    PLUHUB_LIVE_KEY: token,
    PLUHUB_LIVE_MODEL: model,
    PLUHUB_LIVE_CHANNEL: channel,
  } = process.env;
  if (!url || !token || !model)
    throw new Error(
      "Set PLUHUB_LIVE_URL, PLUHUB_LIVE_KEY and PLUHUB_LIVE_MODEL explicitly",
    );
  console.log(
    JSON.stringify(await verifyLiveSearch({ url, token, model, channel })),
  );
}
