import { Tooltip } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";

export function IconButton(props: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        className="btn btn-ghost icon-btn"
        aria-label={props.label}
        onClick={props.onClick}
        disabled={props.disabled}
      >
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6}>
          <Tooltip.Popup className="tooltip">{props.label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
