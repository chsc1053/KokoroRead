/**
 * @file text-map.ts
 * @description Maps absolute character offsets in extracted text to live DOM Ranges.
 */

const NOISE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "[role='navigation']",
  "[role='banner']",
  "[role='complementary']",
  "[aria-hidden='true']",
  ".advertisement",
  ".ad",
  ".ads",
  ".sidebar",
  ".comments",
  ".social-share",
  ".share-buttons",
  "#comments",
].join(",");

interface TextSeg {
  node: Text;
  nodeOffset: number;
  globalStart: number;
  length: number;
}

/**
 * Bidirectional map between extracted/spoken text and live Text nodes.
 */
export class LiveTextMap {
  readonly text: string;
  private readonly segs: TextSeg[];

  private constructor(text: string, segs: TextSeg[]) {
    this.text = text;
    this.segs = segs;
  }

  static empty(): LiveTextMap {
    return new LiveTextMap("", []);
  }

  /** Build from the user's current Selection. */
  static fromSelection(): LiveTextMap | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const builder = new MapBuilder();
    for (let r = 0; r < sel.rangeCount; r += 1) {
      builder.appendRange(sel.getRangeAt(r));
    }
    builder.trim();
    return builder.text ? new LiveTextMap(builder.text, builder.segs) : null;
  }

  /** Build from an article / newsletter root element. */
  static fromRoot(root: Element): LiveTextMap {
    const builder = new MapBuilder();
    const blocks = collectBlocks(root);
    if (blocks.length >= 2) {
      for (let i = 0; i < blocks.length; i += 1) {
        const before = builder.text.length;
        builder.appendElement(blocks[i]!);
        builder.collapseSpacesInTail(before);
        builder.trimTailSegment(before);
        if (builder.text.length > before && i < blocks.length - 1) {
          builder.appendVirtual("\n\n");
        }
      }
    } else {
      builder.appendElement(root);
      builder.collapseSpacesInTail(0);
    }
    builder.trim();
    return new LiveTextMap(builder.text, builder.segs);
  }

  rangesFor(start: number, end: number): Range[] {
    if (end <= start || this.segs.length === 0) return [];
    const ranges: Range[] = [];
    let cur: Range | null = null;
    let curNode: Text | null = null;

    for (const seg of this.segs) {
      const segEnd = seg.globalStart + seg.length;
      if (segEnd <= start || seg.globalStart >= end) continue;

      const localStart = Math.max(0, start - seg.globalStart);
      const localEnd = Math.min(seg.length, end - seg.globalStart);
      if (localEnd <= localStart) continue;

      const nodeStart = seg.nodeOffset + localStart;
      const nodeEnd = seg.nodeOffset + localEnd;

      if (cur && curNode === seg.node) {
        try {
          cur.setEnd(seg.node, nodeEnd);
        } catch {
          cur = null;
          curNode = null;
        }
        continue;
      }

      if (cur) ranges.push(cur);
      cur = document.createRange();
      try {
        cur.setStart(seg.node, nodeStart);
        cur.setEnd(seg.node, nodeEnd);
        curNode = seg.node;
      } catch {
        cur = null;
        curNode = null;
      }
    }
    if (cur) ranges.push(cur);
    return ranges;
  }
}

class MapBuilder {
  text = "";
  segs: TextSeg[] = [];

  appendVirtual(chunk: string): void {
    this.text += chunk;
  }

  appendElement(root: Element): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isNoiseNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode() as Text | null;
    while (node) {
      const value = node.nodeValue ?? "";
      if (value.length > 0) this.appendNodeSlice(node, 0, value.length);
      node = walker.nextNode() as Text | null;
    }
  }

  appendRange(range: Range): void {
    const root = range.commonAncestorContainer;

    // Selection entirely within one text node — TreeWalker only visits
    // descendants, so it would miss the root text node and return empty.
    if (root.nodeType === Node.TEXT_NODE) {
      const node = root as Text;
      if (!isNoiseNode(node) && range.endOffset > range.startOffset) {
        this.appendNodeSlice(node, range.startOffset, range.endOffset);
      }
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (isNoiseNode(node)) return NodeFilter.FILTER_REJECT;
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node = walker.nextNode() as Text | null;
    while (node) {
      const value = node.nodeValue ?? "";
      let start = 0;
      let end = value.length;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (end > start) this.appendNodeSlice(node, start, end);
      node = walker.nextNode() as Text | null;
    }
  }

  appendNodeSlice(node: Text, start: number, end: number): void {
    const raw = (node.nodeValue ?? "").slice(start, end);
    for (let i = 0; i < raw.length; i += 1) {
      let ch = raw[i]!;
      if (ch === "\u00a0") ch = " ";
      if (/[\u200B-\u200D\uFEFF]/.test(ch)) continue;
      this.pushChar(ch, node, start + i);
    }
  }

  /** Collapse runs of spaces/tabs/newlines in the tail to single spaces (block-local). */
  collapseSpacesInTail(from: number): void {
    const head = this.text.slice(0, from);
    const tail = this.text.slice(from);
    const collapsed = tail.replace(/[ \t\n\r]+/g, " ");
    if (collapsed === tail) return;

    // Rebuild segs for the tail by re-walking characters — keep segs that still apply.
    const kept = this.segs.filter((s) => s.globalStart + s.length <= from);
    const remapped: TextSeg[] = [...kept];
    let out = head;
    let rawIdx = from;
    let i = 0;
    while (i < tail.length) {
      if (/[ \t\n\r]/.test(tail[i]!)) {
        while (i < tail.length && /[ \t\n\r]/.test(tail[i]!)) {
          i += 1;
          rawIdx += 1;
        }
        // Find an anchor near this space if possible.
        const anchor = findAnchor(this.segs, rawIdx - 1) ?? findAnchor(this.segs, rawIdx);
        pushMapped(remapped, out.length, " ", anchor);
        out += " ";
        continue;
      }
      const anchor = findAnchor(this.segs, rawIdx);
      pushMapped(remapped, out.length, tail[i]!, anchor);
      out += tail[i]!;
      i += 1;
      rawIdx += 1;
    }
    this.text = out;
    this.segs = remapped;
  }

  trimTailSegment(from: number): void {
    while (this.text.length > from && this.text.endsWith(" ")) {
      this.popLastChar();
    }
    while (this.text.length > from && this.text[from] === " ") {
      // Rare: leading space in block — drop from map.
      this.text = this.text.slice(0, from) + this.text.slice(from + 1);
      this.segs = reindexAfterDelete(this.segs, from, 1);
    }
  }

  trim(): void {
    while (this.text.startsWith(" ") || this.text.startsWith("\n")) {
      const n = this.text.startsWith("\n\n") ? 2 : 1;
      this.text = this.text.slice(n);
      this.segs = reindexAfterDelete(this.segs, 0, n);
    }
    while (this.text.endsWith(" ") || this.text.endsWith("\n")) {
      this.popLastChar();
    }
    // Collapse 3+ newlines already avoided; collapse double spaces globally.
    this.collapseDoubleSpaces();
  }

  private collapseDoubleSpaces(): void {
    let idx: number;
    while ((idx = this.text.indexOf("  ")) !== -1) {
      this.text = this.text.slice(0, idx) + this.text.slice(idx + 1);
      this.segs = reindexAfterDelete(this.segs, idx, 1);
    }
  }

  private pushChar(ch: string, node: Text, nodeOffset: number): void {
    const last = this.segs[this.segs.length - 1];
    if (
      last &&
      last.node === node &&
      last.nodeOffset + last.length === nodeOffset &&
      last.globalStart + last.length === this.text.length
    ) {
      last.length += 1;
    } else {
      this.segs.push({
        node,
        nodeOffset,
        globalStart: this.text.length,
        length: 1,
      });
    }
    this.text += ch;
  }

  private popLastChar(): void {
    if (!this.text) return;
    const drop = this.text.endsWith("\n\n") ? 2 : 1;
    const at = this.text.length - drop;
    this.text = this.text.slice(0, at);
    this.segs = reindexAfterDelete(this.segs, at, drop);
  }
}

function pushMapped(
  segs: TextSeg[],
  globalStart: number,
  _ch: string,
  anchor: { node: Text; nodeOffset: number } | null,
): void {
  if (!anchor) return;
  const last = segs[segs.length - 1];
  if (
    last &&
    last.node === anchor.node &&
    last.nodeOffset + last.length === anchor.nodeOffset &&
    last.globalStart + last.length === globalStart
  ) {
    last.length += 1;
    return;
  }
  segs.push({
    node: anchor.node,
    nodeOffset: anchor.nodeOffset,
    globalStart,
    length: 1,
  });
}

function findAnchor(
  segs: TextSeg[],
  globalIndex: number,
): { node: Text; nodeOffset: number } | null {
  for (const seg of segs) {
    if (globalIndex >= seg.globalStart && globalIndex < seg.globalStart + seg.length) {
      return {
        node: seg.node,
        nodeOffset: seg.nodeOffset + (globalIndex - seg.globalStart),
      };
    }
  }
  return null;
}

function reindexAfterDelete(segs: TextSeg[], at: number, count: number): TextSeg[] {
  const out: TextSeg[] = [];
  for (const seg of segs) {
    const segEnd = seg.globalStart + seg.length;
    if (segEnd <= at) {
      out.push(seg);
      continue;
    }
    if (seg.globalStart >= at + count) {
      out.push({ ...seg, globalStart: seg.globalStart - count });
      continue;
    }
    // Overlaps deleted span — split / shrink.
    const keepLeft = Math.max(0, at - seg.globalStart);
    const keepRightStart = Math.max(at + count, seg.globalStart);
    const rightLen = segEnd - keepRightStart;
    if (keepLeft > 0) {
      out.push({
        node: seg.node,
        nodeOffset: seg.nodeOffset,
        globalStart: seg.globalStart,
        length: keepLeft,
      });
    }
    if (rightLen > 0) {
      out.push({
        node: seg.node,
        nodeOffset: seg.nodeOffset + (keepRightStart - seg.globalStart),
        globalStart: at,
        length: rightLen,
      });
    }
  }
  return out;
}

function isNoiseNode(node: Node): boolean {
  const el =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  if (!el) return false;
  return el.closest(NOISE_SELECTOR) !== null;
}

function collectBlocks(root: Element): Element[] {
  const blocks = root.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, pre, td");
  const out: Element[] = [];
  blocks.forEach((el) => {
    if (isNoiseNode(el)) return;
    if (el.textContent?.trim()) out.push(el);
  });
  return out;
}
