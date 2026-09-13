import { type ClassValue, clsx } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/** The theme's named font sizes. Without this list tailwind-merge treats
 *  `text-label` as a colour and drops `text-primary-foreground` beside it. */
const fontSizes = [
  "h1",
  "h2",
  "h3",
  "body-md",
  "body-sm",
  "label",
  "caption",
  "mono-md",
  "mono-sm",
  "mono-xs",
  "numeral",
  "button",
  "sign",
  "stamp",
  "display",
]

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: fontSizes }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
