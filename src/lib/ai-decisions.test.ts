import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createDecisions,
  DecisionsApiError,
  decisionsEndpointUnsupported,
  decisionsModelUnsupported,
  parseDecisionsPayload,
  resolveDecisionsUrl,
  serializeDecisionsBody,
  type DecisionsChoiceAnswer,
} from "./ai-decisions";
import type { ResolvedProvider } from "./ai-provider";

function makeProvider(
  overrides: Partial<ResolvedProvider> = {},
): ResolvedProvider {
  return {
    providerType: "openai",
    apiKey: "sk-test-key",
    baseUrl: null,
    model: "gpt-6-luna",
    serviceTier: null,
    thinkingLevel: null,
    cfAigByokAlias: null,
    timeoutMs: 30_000,
    apiSurface: "chat_completions",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai-decisions", () => {
  describe("resolveDecisionsUrl", () => {
    it("defaults to OpenAI /v1/decisions when baseUrl is null", () => {
      expect(resolveDecisionsUrl(makeProvider())).toBe(
        "https://api.openai.com/v1/decisions",
      );
    });

    it("appends /decisions to a /v1 baseUrl without duplicating /v1", () => {
      expect(
        resolveDecisionsUrl(
          makeProvider({ baseUrl: "https://proxy.example.test/v1/" }),
        ),
      ).toBe("https://proxy.example.test/v1/decisions");
    });

    it("strips /chat/completions suffix when normalizing a baseUrl", () => {
      expect(
        resolveDecisionsUrl(
          makeProvider({
            baseUrl: "https://proxy.example.test/v1/chat/completions",
          }),
        ),
      ).toBe("https://proxy.example.test/v1/decisions");
    });

    it("preserves an already-complete /decisions URL", () => {
      expect(
        resolveDecisionsUrl(
          makeProvider({ baseUrl: "https://proxy.example.test/v1/decisions" }),
        ),
      ).toBe("https://proxy.example.test/v1/decisions");
    });
  });

  describe("serializeDecisionsBody", () => {
    it("serializes string and object choices as wire objects without a store parameter", () => {
      const body = serializeDecisionsBody({
        model: "gpt-6-luna",
        input: "Explain your work",
        questions: [
          {
            name: "check2",
            type: "choice",
            instructions: "Classify",
            choices: [
              "sound",
              { value: "neither", description: "Unclear or off-topic" },
            ],
          },
        ],
      });
      expect("store" in body).toBe(false);
      expect(body.model).toBe("gpt-6-luna");
      expect(body.questions).toEqual([
        {
          name: "check2",
          type: "choice",
          instructions: "Classify",
          choices: [
            { value: "sound" },
            { value: "neither", description: "Unclear or off-topic" },
          ],
        },
      ]);
    });

    it("serializes predicate and score level objects properly", () => {
      const body = serializeDecisionsBody({
        model: "gpt-6-luna",
        input: "Text",
        questions: [
          {
            name: "q1",
            type: "predicate",
            instructions: "Is this valid?",
          },
          {
            name: "q2",
            type: "score",
            instructions: "Rate clarity",
            levels: ["low", { label: "high", description: "Clear and exact" }],
          },
        ],
      });
      expect("store" in body).toBe(false);
      expect(body.questions).toEqual([
        {
          name: "q1",
          type: "predicate",
          instructions: "Is this valid?",
        },
        {
          name: "q2",
          type: "score",
          instructions: "Rate clarity",
          levels: [
            { label: "low" },
            { label: "high", description: "Clear and exact" },
          ],
        },
      ]);
    });
  });

  describe("parseDecisionsPayload", () => {
    it("parses structured choice answers with probabilities and confidence", () => {
      const answers = parseDecisionsPayload({
        answers: [
          {
            name: "check2_classification",
            type: "choice",
            choice: "M1",
            confidence: 0.91,
            probabilities: [
              { value: "M1", probability: 0.91 },
              { value: "neither", probability: 0.06 },
              { value: "sound", probability: 0.03 },
            ],
          },
        ],
      });

      expect(answers).toHaveLength(1);
      const first = answers[0] as DecisionsChoiceAnswer;
      expect(first).toMatchObject({
        name: "check2_classification",
        type: "choice",
        choice: "M1",
        confidence: 0.91,
      });
      expect(first.probabilities).toHaveLength(3);
    });

    it("derives confidence from matching choice probability when confidence is omitted", () => {
      const answers = parseDecisionsPayload({
        answers: [
          {
            name: "q1",
            type: "choice",
            choice: "sound",
            probabilities: [
              { value: "sound", probability: 0.85 },
              { value: "neither", probability: 0.15 },
            ],
          },
        ],
      });
      const first = answers[0] as DecisionsChoiceAnswer;
      expect(first.confidence).toBe(0.85);
      expect(first.probabilities[0]).toEqual({
        value: "sound",
        probability: 0.85,
      });
    });

    it("parses predicate answers without an explicit boolean value and score answers with probabilities", () => {
      const answers = parseDecisionsPayload({
        answers: [
          {
            name: "is_sound",
            type: "predicate",
            probability: 0.92,
          },
          {
            name: "is_off_topic",
            type: "predicate",
            probability: 0.12,
          },
          {
            name: "clarity",
            type: "score",
            score: 2.0,
            confidence: 0.95,
            probabilities: [
              { value: 0, label: "low", probability: 0.0 },
              { value: 1, label: "medium", probability: 0.05 },
              { value: 2, label: "high", probability: 0.95 },
            ],
          },
        ],
      });
      expect(answers[0]).toMatchObject({
        name: "is_sound",
        type: "predicate",
        value: true,
        probability: 0.92,
      });
      expect(answers[1]).toMatchObject({
        name: "is_off_topic",
        type: "predicate",
        value: false,
        probability: 0.12,
      });
      expect(answers[2]).toMatchObject({
        name: "clarity",
        type: "score",
        score: 2.0,
        confidence: 0.95,
      });
    });

    it("throws on malformed payload without answers array", () => {
      expect(() => parseDecisionsPayload({ foo: "bar" })).toThrow();
    });
  });

  describe("error classifiers", () => {
    it("detects unsupported /v1/decisions endpoint (404/405/501/message)", () => {
      expect(
        decisionsEndpointUnsupported(
          new DecisionsApiError("Not found", { status: 404 }),
        ),
      ).toBe(true);
      expect(
        decisionsEndpointUnsupported(
          new DecisionsApiError(
            "Compatibility endpoint: decisions is not supported",
            { status: 400, code: "2019" },
          ),
        ),
      ).toBe(true);
      expect(
        decisionsEndpointUnsupported(
          new DecisionsApiError("Rate limit", { status: 429 }),
        ),
      ).toBe(false);
    });

    it("detects unsupported model errors", () => {
      expect(
        decisionsModelUnsupported(
          new DecisionsApiError("model_not_supported", {
            status: 400,
            code: "model_not_supported",
          }),
        ),
      ).toBe(true);
      expect(
        decisionsModelUnsupported(
          new DecisionsApiError("timeout", { status: 504 }),
        ),
      ).toBe(false);
    });
  });

  describe("createDecisions", () => {
    it("POSTs to /v1/decisions with bearer token and parses answers", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "dec_live",
            model: "gpt-6-luna",
            answers: [
              {
                name: "ping",
                type: "choice",
                choice: "ok",
                confidence: 0.99,
                probabilities: [{ value: "ok", probability: 0.99 }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const res = await createDecisions(
        makeProvider(),
        {
          model: "gpt-6-luna",
          input: "test",
          questions: [
            {
              name: "ping",
              type: "choice",
              instructions: "Reply ok",
              choices: ["ok", "other"],
            },
          ],
        },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/decisions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk-test-key",
      );
      const sentBody = JSON.parse(init.body as string);
      expect("store" in sentBody).toBe(false);
      expect(sentBody.questions[0].choices).toEqual([
        { value: "ok" },
        { value: "other" },
      ]);
      expect((res.answers[0] as DecisionsChoiceAnswer).choice).toBe("ok");
    });

    it("throws DecisionsApiError on non-2xx HTTP status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "Unsupported model",
              code: "model_not_supported",
            },
          }),
          { status: 400 },
        ),
      );

      await expect(
        createDecisions(
          makeProvider(),
          {
            model: "gpt-6-luna",
            input: "test",
            questions: [
              {
                name: "ping",
                type: "choice",
                instructions: "Reply ok",
                choices: ["ok"],
              },
            ],
          },
          { fetchImpl: fetchMock as unknown as typeof fetch },
        ),
      ).rejects.toMatchObject({
        status: 400,
        code: "model_not_supported",
      });
    });
  });
});
