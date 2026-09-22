"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  prepareAttachment,
  type PreparedAttachment,
} from "./attachment-input";

function release(attachments: PreparedAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

/** Own each preview until its attachment is removed, sent, or abandoned. */
export function useAssistantAttachments({
  enabled,
  maxAttachments,
  maxBytes,
  onNotice,
}: {
  enabled: boolean;
  maxAttachments: number;
  maxBytes: number;
  onNotice: (message: string) => void;
}) {
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  const [preparing, setPreparing] = useState(false);
  const owned = useRef<PreparedAttachment[]>([]);
  const generation = useRef(0);
  const pending = useRef(0);

  useEffect(
    () => () => {
      generation.current += 1;
      pending.current = 0;
      release(owned.current);
      owned.current = [];
    },
    [],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    pending.current = 0;
    release(owned.current);
    owned.current = [];
    setAttachments([]);
    setPreparing(false);
  }, []);

  const remove = useCallback((id: string) => {
    release(owned.current.filter((attachment) => attachment.id === id));
    owned.current = owned.current.filter((attachment) => attachment.id !== id);
    setAttachments(owned.current);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!enabled || files.length === 0) return;
      const room = Math.max(
        0,
        maxAttachments - owned.current.length - pending.current,
      );
      if (room === 0) {
        onNotice(
          `You can attach at most ${maxAttachments} file(s) per message.`,
        );
        return;
      }

      const selected = files.slice(0, room);
      const requestGeneration = generation.current;
      pending.current += selected.length;
      setPreparing(true);
      // A failed file must not discard (and leak) previews prepared for its peers.
      const results = await Promise.allSettled(selected.map(prepareAttachment));
      const prepared = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (generation.current !== requestGeneration) {
        release(prepared);
        return;
      }

      pending.current -= selected.length;
      setPreparing(pending.current > 0);
      const tooBig = prepared.filter(
        (file) => maxBytes > 0 && file.bytes > maxBytes,
      );
      release(tooBig);
      const kept = prepared.filter((file) => !tooBig.includes(file));
      owned.current = [...owned.current, ...kept];
      setAttachments(owned.current);

      if (results.some((result) => result.status === "rejected")) {
        onNotice(
          "Some files could not be read. Please try attaching them again.",
        );
      } else if (tooBig.length > 0) {
        onNotice(
          `${tooBig.map((file) => file.name).join(", ")} exceeded the ${formatBytes(maxBytes)} limit.`,
        );
      } else if (files.length > room) {
        onNotice(`Only the first ${room} file(s) were attached.`);
      }
    },
    [enabled, maxAttachments, maxBytes, onNotice],
  );

  return { attachments, preparing, addFiles, remove, clear };
}
