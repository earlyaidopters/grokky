import { useLayoutEffect, useRef, useState } from "react";

/** Follow a growing reply only while the reader is at the bottom. */
export function useConversationScroll(conversationId: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; following: boolean }>());
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const remember = () => {
    const scroll = scrollRef.current;
    if (scroll) positions.current.set(conversationId, { top: scroll.scrollTop, following: following.current });
  };
  const jumpToLatest = () => {
    const scroll = scrollRef.current;
    following.current = true;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    setShowLatest(false);
    remember();
  };
  const onScroll = () => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    following.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
    setShowLatest(!following.current);
    remember();
  };

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const saved = positions.current.get(conversationId);
    following.current = saved?.following ?? true;
    scroll.scrollTop = following.current ? scroll.scrollHeight : saved?.top ?? 0;
    setShowLatest(!following.current);
    const observer = new ResizeObserver(() => {
      if (following.current) scroll.scrollTop = scroll.scrollHeight;
      positions.current.set(conversationId, { top: scroll.scrollTop, following: following.current });
    });
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId]);

  // Apply React content changes before the browser emits a scroll anchoring event.
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (scroll && following.current) scroll.scrollTop = scroll.scrollHeight;
  });

  const isFollowing = () => positions.current.get(conversationId)?.following ?? true;
  return { scrollRef, contentRef, onScroll, showLatest, jumpToLatest, isFollowing };
}
