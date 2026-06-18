"use client";

import { useLayoutEffect, useRef, useState } from "react";

export interface TagLegendProps {
  items: { label: string; color: string }[];
}

export function TagLegend({ items }: TagLegendProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ visibleCount, showMoreCount }, setVisible] = useState({
    visibleCount: items.length,
    showMoreCount: 0,
  });

  const lastWidthRef = useRef<number>(0);

  useLayoutEffect(() => {
    const recalculate = () => {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.getBoundingClientRect().width || container.offsetWidth;
      if (containerWidth === 0) return;

      lastWidthRef.current = containerWidth;

      const computedStyle = window.getComputedStyle(container);
      const gap = parseFloat(computedStyle.columnGap) || 14;

      // Create a temporary hidden container for layout measurement
      const measureContainer = document.createElement("div");
      measureContainer.className = "legend";
      measureContainer.style.position = "absolute";
      measureContainer.style.visibility = "hidden";
      measureContainer.style.pointerEvents = "none";
      measureContainer.style.left = "-9999px";
      measureContainer.style.top = "-9999px";
      measureContainer.style.whiteSpace = "nowrap";
      measureContainer.style.width = "max-content";
      measureContainer.style.display = "flex";
      container.appendChild(measureContainer);

      // Measure each item
      const itemWidths = items.map((item) => {
        const span = document.createElement("span");
        const i = document.createElement("i");
        i.style.background = item.color;
        span.appendChild(i);
        span.appendChild(document.createTextNode(item.label));
        measureContainer.appendChild(span);
        const width = span.getBoundingClientRect().width;
        return width;
      });

      // Measure '+N more' indicator width dynamically
      const measureMoreWidth = (n: number) => {
        const span = document.createElement("span");
        span.className = "more-indicator";
        span.appendChild(document.createTextNode(`+${n} more`));
        measureContainer.appendChild(span);
        const width = span.getBoundingClientRect().width;
        measureContainer.removeChild(span);
        return width;
      };

      let selectedVisibleCount = items.length;
      let selectedShowMoreCount = 0;

      // Case 1: All items fit
      const totalAllWidth =
        itemWidths.reduce((sum, w) => sum + w, 0) + (items.length - 1) * gap;

      if (totalAllWidth <= containerWidth) {
        selectedVisibleCount = items.length;
        selectedShowMoreCount = 0;
      } else {
        // Case 2: Some items must be hidden. Check combinations from k items down to 0
        for (let k = items.length - 1; k >= 0; k--) {
          const N = items.length - k;
          let neededWidth = 0;

          if (k > 0) {
            const itemsWidth = itemWidths.slice(0, k).reduce((sum, w) => sum + w, 0);
            if (N === 1) {
              // Except if only 1 item remains, where the indicator does not need to be reserved
              neededWidth = itemsWidth + (k - 1) * gap;
            } else {
              neededWidth = itemsWidth + k * gap + measureMoreWidth(N);
            }
          } else {
            // k === 0: only "+N more" fits
            neededWidth = measureMoreWidth(N);
          }

          if (neededWidth <= containerWidth || k === 0) {
            selectedVisibleCount = k;
            selectedShowMoreCount = N;
            break;
          }
        }
      }

      // Clean up measurement container
      container.removeChild(measureContainer);

      setVisible({
        visibleCount: selectedVisibleCount,
        showMoreCount: selectedShowMoreCount,
      });
    };

    recalculate();

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        if (Math.abs(width - lastWidthRef.current) > 0.5) {
          window.requestAnimationFrame(() => {
            recalculate();
          });
        }
      }
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [items]);

  const visibleItems = items.slice(0, visibleCount);

  return (
    <div
      ref={containerRef}
      className="legend"
      style={{
        maxHeight: "20px", // Safety net setinggi satu baris
        overflow: "hidden",
        flexWrap: "nowrap", // Ensure nowrap visually
      }}
    >
      {visibleItems.map((item, idx) => (
        <span key={item.label || idx}>
          <i style={{ background: item.color }}></i>
          {item.label}
        </span>
      ))}
      {showMoreCount > 0 && (
        <span className="more-indicator" style={{ color: "var(--muted)", cursor: "pointer" }}>
          +{showMoreCount} more
        </span>
      )}
    </div>
  );
}
