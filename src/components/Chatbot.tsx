"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Eraser, MessageCircle, Send, Square, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Rnd } from "react-rnd";
import remarkGfm from "remark-gfm";

type Recommendation = {
  questionText: string;
  materialTitle: string;
  pageRange: { start: number; end: number };
  fileReason: string;
  pageReason: string;
  pages: { pageNumber: number; imageUrl: string }[];
};

type TextMessage = {
  role: "user" | "assistant";
  content: string;
};

type RecommendationsMessage = {
  role: "assistant";
  kind: "recommendations";
  recommendations: Recommendation[];
  truncated?: boolean;
};

type Message = TextMessage | RecommendationsMessage;

function isRecommendationsMessage(message: Message): message is RecommendationsMessage {
  return "kind" in message && message.kind === "recommendations";
}

type ChatMode = "chat" | "quiz-review";

type ViewportSize = {
  width: number;
  height: number;
};

type PanelState = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const INITIAL_ASSISTANT_MESSAGE = "Hello! How can I help you today?";
const PANEL_MARGIN = 16;
const DEFAULT_CHAT_WIDTH = 384;
const DEFAULT_CHAT_HEIGHT = 500;
const PREFERRED_MIN_CHAT_WIDTH = 280;
const PREFERRED_MIN_CHAT_HEIGHT = 360;
const ASSISTANT_MARKDOWN_CLASS_NAME =
  "[&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-1 [&_a]:font-medium [&_a]:text-blue-600 [&_a]:underline [&_a]:underline-offset-2 dark:[&_a]:text-blue-400 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:italic dark:[&_blockquote]:border-gray-600 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-gray-950 [&_pre]:p-3 [&_pre]:text-gray-100 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded [&_code]:bg-gray-200/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] dark:[&_code]:bg-gray-700/80";

function getInitialMessages(): Message[] {
  return [{ role: "assistant", content: INITIAL_ASSISTANT_MESSAGE }];
}

function getApiMessages(messages: Message[]): TextMessage[] {
  return messages.filter(
    (message, index): message is TextMessage =>
      !isRecommendationsMessage(message) &&
      !(index === 0 && message.role === "assistant" && message.content === INITIAL_ASSISTANT_MESSAGE)
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getViewportSize(): ViewportSize {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }

  return { width: window.innerWidth, height: window.innerHeight };
}

function getPanelLimits(viewport: ViewportSize) {
  const maxWidth = Math.max(1, viewport.width - PANEL_MARGIN * 2);
  const maxHeight = Math.max(1, viewport.height - PANEL_MARGIN * 2);

  return {
    minWidth: Math.min(PREFERRED_MIN_CHAT_WIDTH, maxWidth),
    minHeight: Math.min(PREFERRED_MIN_CHAT_HEIGHT, maxHeight),
    maxWidth,
    maxHeight,
  };
}

function createInitialPanelState(viewport: ViewportSize): PanelState {
  const limits = getPanelLimits(viewport);
  const width = clamp(DEFAULT_CHAT_WIDTH, limits.minWidth, limits.maxWidth);
  const height = clamp(DEFAULT_CHAT_HEIGHT, limits.minHeight, limits.maxHeight);

  return {
    width,
    height,
    x: Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN),
    y: Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN),
  };
}

function constrainPanelState(
  panelState: PanelState | null,
  viewport: ViewportSize
): PanelState | null {
  if (!viewport.width || !viewport.height) {
    return panelState;
  }

  const limits = getPanelLimits(viewport);
  const basePanelState = panelState ?? createInitialPanelState(viewport);
  const width = clamp(basePanelState.width, limits.minWidth, limits.maxWidth);
  const height = clamp(basePanelState.height, limits.minHeight, limits.maxHeight);

  return {
    width,
    height,
    x: clamp(basePanelState.x, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN)),
    y: clamp(
      basePanelState.y,
      PANEL_MARGIN,
      Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN)
    ),
  };
}

export default function Chatbot() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(getInitialMessages);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRecommending, setIsRecommending] = useState(false);
  const hasAutoReviewTriggeredRef = useRef(false);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [panelState, setPanelState] = useState<PanelState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef(0);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen, isRecommending]);

  useEffect(() => {
    const syncViewport = () => {
      const nextViewport = getViewportSize();
      setViewportSize(nextViewport);
      setPanelState((prev) => constrainPanelState(prev, nextViewport));
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);

    return () => {
      window.removeEventListener("resize", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || hasAutoReviewTriggeredRef.current) return;

    hasAutoReviewTriggeredRef.current = true;
    void (async () => {
      await sendRequest({
        messages: getInitialMessages(),
        mode: "quiz-review",
      });
      await fetchRecommendations();
    })();
  }, [isOpen]);

  const cancelActiveRequest = () => {
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setIsRecommending(false);
  };

  const resetConversation = () => {
    cancelActiveRequest();
    setMessages(getInitialMessages());
    setInput("");
  };

  const handleClose = () => {
    resetConversation();
    hasAutoReviewTriggeredRef.current = false;
    setIsOpen(false);
  };

  const handleClearContext = () => {
    resetConversation();
  };

  const sendRequest = async ({
    messages: requestMessages,
    mode,
  }: {
    messages: Message[];
    mode: ChatMode;
  }) => {
    cancelActiveRequest();

    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          mode,
          messages: getApiMessages(requestMessages).map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      if (response.status === 204) {
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to fetch from API");
      }

      if (activeRequestIdRef.current !== requestId) {
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = "";
      let sawReasoningContent = false;

      const startTime = Date.now();
      let firstTokenTime: number | null = null;
      let completionTokens = 0;

      if (reader) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (activeRequestIdRef.current !== requestId) {
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith("data: ") && trimmedLine !== "data: [DONE]") {
              try {
                const data = JSON.parse(trimmedLine.slice(6));

                if (data.usage?.completion_tokens) {
                  completionTokens = data.usage.completion_tokens;
                }

                const delta = data.choices?.[0]?.delta;

                if (delta?.reasoning_content && !assistantMessage) {
                  sawReasoningContent = true;
                  setMessages((prev) => {
                    if (activeRequestIdRef.current !== requestId || prev.length === 0) {
                      return prev;
                    }

                    const nextMessages = [...prev];
                    const lastMessage = nextMessages[nextMessages.length - 1];
                    if (isRecommendationsMessage(lastMessage) || lastMessage.content) {
                      return prev;
                    }

                    nextMessages[nextMessages.length - 1] = {
                      role: "assistant",
                      content: "*Thinking...*",
                    };
                    return nextMessages;
                  });
                }

                if (delta?.content) {
                  if (!firstTokenTime) {
                    firstTokenTime = Date.now();
                  }

                  assistantMessage += delta.content;
                  setMessages((prev) => {
                    if (activeRequestIdRef.current !== requestId || prev.length === 0) {
                      return prev;
                    }

                    const nextMessages = [...prev];
                    nextMessages[nextMessages.length - 1] = {
                      role: "assistant",
                      content: assistantMessage,
                    };
                    return nextMessages;
                  });
                }
              } catch {
                // Ignore parse errors from fragmentary chunks.
              }
            }
          }
        }
      }

      if (!assistantMessage) {
        setMessages((prev) => {
          if (activeRequestIdRef.current !== requestId || prev.length === 0) {
            return prev;
          }

          const nextMessages = [...prev];
          nextMessages[nextMessages.length - 1] = {
            role: "assistant",
            content: sawReasoningContent
              ? "The model only returned reasoning tokens and no final answer. Try increasing the token limit or disabling thinking for this local model."
              : "The model returned an empty response.",
          };
          return nextMessages;
        });
      }

      const endTime = Date.now();
      const ttft = firstTokenTime ? firstTokenTime - startTime : 0;
      const streamingDuration = firstTokenTime ? (endTime - firstTokenTime) / 1000 : 0;
      const tps =
        completionTokens && streamingDuration > 0
          ? (completionTokens / streamingDuration).toFixed(1)
          : 0;

      if (ttft > 0 && completionTokens > 0) {
        setMessages((prev) => {
          if (activeRequestIdRef.current !== requestId || prev.length === 0) {
            return prev;
          }

          const nextMessages = [...prev];
          nextMessages[nextMessages.length - 1] = {
            role: "assistant",
            content: `${assistantMessage}\n\n*(TTFT: ${ttft}ms | ${tps} tok/s)*`,
          };
          return nextMessages;
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      console.error(error);
      if (activeRequestIdRef.current !== requestId) {
        return;
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, an error occurred while processing your request." },
      ]);
    } finally {
      if (activeRequestIdRef.current === requestId) {
        setIsLoading(false);
        abortControllerRef.current = null;
      }
    }
  };

  const fetchRecommendations = async () => {
    const requestId = activeRequestIdRef.current;
    setIsRecommending(true);

    try {
      const response = await fetch("/api/chat/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      if (activeRequestIdRef.current !== requestId) {
        return;
      }

      const recommendations = data?.recommendations;
      if (Array.isArray(recommendations) && recommendations.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            kind: "recommendations",
            recommendations: recommendations as Recommendation[],
            truncated: data?.truncated === true,
          },
        ]);
      }
    } catch {
      // The text review is already shown; silently skip recommendations on error.
    } finally {
      if (activeRequestIdRef.current === requestId) {
        setIsRecommending(false);
      }
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input };
    const nextMessages = [...messages, userMessage];

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    await sendRequest({
      messages: nextMessages,
      mode: "chat",
    });
  };

  const panelLimits = getPanelLimits(viewportSize);

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {isOpen && panelState ? (
        <Rnd
          bounds="parent"
          className="pointer-events-auto"
          position={{ x: panelState.x, y: panelState.y }}
          size={{ width: panelState.width, height: panelState.height }}
          minWidth={panelLimits.minWidth}
          minHeight={panelLimits.minHeight}
          maxWidth={panelLimits.maxWidth}
          maxHeight={panelLimits.maxHeight}
          dragHandleClassName="chatbot-drag-handle"
          cancel=".chatbot-no-drag"
          enableResizing={{ bottomRight: true }}
          resizeHandleComponent={{
            bottomRight: (
              <div className="size-4 cursor-se-resize rounded-tl-md border-l border-t border-gray-300 bg-white/80 dark:border-gray-600 dark:bg-gray-800/80" />
            ),
          }}
          onDragStop={(_event, data) => {
            setPanelState((prev) => (prev ? { ...prev, x: data.x, y: data.y } : prev));
          }}
          onResizeStop={(_event, _direction, ref, _delta, position) => {
            setPanelState({
              width: ref.offsetWidth,
              height: ref.offsetHeight,
              x: position.x,
              y: position.y,
            });
          }}
        >
          <div className="flex h-full flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-900">
            <div className="chatbot-drag-handle flex cursor-move select-none items-center justify-between bg-blue-600 px-4 py-3 text-white touch-none">
              <div className="flex items-center gap-x-2">
                <MessageCircle size={20} />
                <h3 className="text-sm font-semibold">AI Assistant</h3>
              </div>
              <div className="chatbot-no-drag flex items-center gap-2">
                <button
                  onClick={handleClearContext}
                  disabled={isLoading}
                  className="inline-flex items-center gap-1 rounded-md border border-white/30 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Clear context"
                  type="button"
                >
                  <Eraser size={14} />
                  Clear
                </button>
                <button
                  onClick={handleClose}
                  className="text-white transition-colors hover:text-gray-200"
                  aria-label="Close chat"
                  type="button"
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="chatbot-no-drag flex-1 space-y-4 overflow-y-auto bg-gray-50 p-4 dark:bg-gray-950">
              {messages.map((message, index) => {
                if (isRecommendationsMessage(message)) {
                  return (
                    <div key="recommendations-message" className="flex justify-start">
                      <div className="w-full max-w-[90%] space-y-3">
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
                          <BookOpen size={14} /> Recommended materials
                        </p>
                        {message.recommendations.map((rec) => (
                          <div
                            key={`${rec.questionText}-${rec.materialTitle}-${rec.pageRange.start}`}
                            className="rounded-2xl rounded-tl-sm border border-gray-100 bg-white p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-800"
                          >
                            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
                              For: <span className="italic">{rec.questionText}</span>
                            </p>
                            <p className="font-medium text-gray-800 dark:text-gray-100">
                              {rec.materialTitle}
                              <span className="ml-1 font-normal text-gray-500 dark:text-gray-400">
                                ·{" "}
                                {rec.pageRange.start === rec.pageRange.end
                                  ? `page ${rec.pageRange.start}`
                                  : `pages ${rec.pageRange.start}–${rec.pageRange.end}`}
                              </span>
                            </p>
                            {(rec.pageReason || rec.fileReason) && (
                              <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                                {rec.pageReason || rec.fileReason}
                              </p>
                            )}
                            <div className="mt-2 max-h-72 space-y-2 overflow-y-auto">
                              {rec.pages.map((pg) => (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  key={pg.pageNumber}
                                  src={pg.imageUrl}
                                  alt={`Page ${pg.pageNumber} of ${rec.materialTitle}`}
                                  loading="lazy"
                                  className="h-auto w-full rounded-lg border border-gray-200 dark:border-gray-700"
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                        {message.truncated && (
                          <p className="text-xs text-gray-400">
                            You missed more questions than shown here. Start with these.
                          </p>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div
                    key={`${index}-${message.role}-${message.content.substring(0, 20)}`}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                        message.role === "user"
                          ? "rounded-tr-sm bg-blue-600 whitespace-pre-wrap text-white"
                          : `rounded-tl-sm border border-gray-100 bg-white text-gray-800 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 ${ASSISTANT_MARKDOWN_CLASS_NAME}`
                      }`}
                    >
                      {message.role === "assistant" ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      ) : (
                        message.content
                      )}
                    </div>
                  </div>
                );
              })}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-x-1 rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                    <div className="size-2 rounded-full bg-gray-400 animate-pulse"></div>
                    <div
                      className="size-2 rounded-full bg-gray-400 animate-pulse"
                      style={{ animationDelay: "0.2s" }}
                    ></div>
                    <div
                      className="size-2 rounded-full bg-gray-400 animate-pulse"
                      style={{ animationDelay: "0.4s" }}
                    ></div>
                  </div>
                </div>
              )}
              {isRecommending && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-x-2 rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2 text-xs text-gray-500 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                    <div className="size-2 rounded-full bg-gray-400 animate-pulse"></div>
                    Finding materials to help you…
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="chatbot-no-drag border-t border-gray-200 bg-white p-3 dark:border-gray-800 dark:bg-gray-900">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
                className="flex items-center gap-x-2"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type your message..."
                  className="flex-1 rounded-full border border-gray-300 bg-gray-50 p-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                  disabled={isLoading}
                  aria-label="Chat message"
                />
                <button
                  type={isLoading ? "button" : "submit"}
                  onClick={isLoading ? cancelActiveRequest : undefined}
                  disabled={!isLoading && !input.trim()}
                  className={`rounded-full p-2 text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isLoading
                      ? "bg-red-600 hover:bg-red-700"
                      : "bg-blue-600 hover:bg-blue-700"
                  }`}
                  aria-label={isLoading ? "Stop response" : "Send message"}
                >
                  {isLoading ? <Square size={18} fill="currentColor" /> : <Send size={18} />}
                </button>
              </form>
            </div>
          </div>
        </Rnd>
      ) : (
        <div className="pointer-events-auto absolute bottom-4 right-4">
          <button type="button"
            onClick={() => setIsOpen(true)}
            className="group flex items-center justify-center rounded-full bg-blue-600 p-4 text-white shadow-lg transition-all duration-300 hover:scale-105 hover:bg-blue-700 hover:shadow-xl"
            aria-label="Open chat"
          >
            <MessageCircle size={24} className="group-hover:animate-pulse" />
          </button>
        </div>
      )}
    </div>
  );
}
