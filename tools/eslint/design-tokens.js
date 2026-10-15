// N-01: ESLint rule `wolfcmd/design-tokens`. Class lists use only the design system's scales
// (packages/ui-kit/CLAUDE.md "Token scales"): the type and icon sizes, the token colors and
// their named fills, lines and tints, the two radii, and no arbitrary values (a size, spacing,
// duration or color written in brackets). A value the scales lack becomes a `--wc-*` token,
// used as `w-(--wc-caption-w)`.

const COLOR_UTILITY =
  "(?:bg|text|border(?:-[xytrblse])?|ring|ring-offset|divide(?:-[xy])?|outline|fill|stroke|from|via|to|decoration|caret|placeholder|shadow|accent)";

/** Each check: a pattern over a class's utility (its variants stripped) and the message. */
const CHECKS = [
  {
    re: /^!?text-\[\d/,
    message:
      "Pixel font size `{{token}}`: use the type scale (text-xs 12 · text-sm 13 · text-md 14 · text-base 15 · text-heading 16 · text-lg 20) or, for icons, text-icon-xs…xl.",
  },
  {
    re: new RegExp(`^!?${COLOR_UTILITY}-[a-z][a-z-]*/(\\d|\\[|\\()`),
    message:
      "Opacity on a color (`{{token}}`): use a named fill, line or tint (fill-quiet/hover/pressed/strong, line, line-strong, <status>-tint, -tint-strong, -line, fg-subtle).",
  },
  {
    re: new RegExp(`^!?${COLOR_UTILITY}-\\[(#|rgb|hsl|oklch|color-mix|var|color:)`),
    message:
      "Raw color `{{token}}`: colors come from the tokens (`bg-accent-tint`, `text-fg-muted`…).",
  },
  {
    re: /^!?rounded(-(?:[trblse]|tl|tr|bl|br|ss|se|es|ee))?(-(?:xs|sm|md|lg|\d?xl|\[[^\]]*\]))?$/,
    // Bare `rounded` and Tailwind's sizes; `rounded-control` etc. don't match (no size group).
    test: (utility) => !/rounded(-[a-z]+)?-(control|overlay|full|none)$/.test(utility),
    message:
      "Radius `{{token}}`: use rounded-control (8 px), rounded-overlay (12 px), rounded-full or rounded-none.",
  },
  {
    // `w-[46px]`, `duration-[120ms]`, `scale-[1.04]`, `top-[calc(100%-4px)]`: a bracketed value
    // with a number in it (a property list such as `transition-[opacity,scale]` is fine).
    re: /^!?-?[a-z][a-z0-9-]*-\[[^\]]*\d[^\]]*\]$/,
    // Already reported above with a more precise message.
    test: (utility) =>
      !/^!?(text-\[\d|rounded)/.test(utility) &&
      !/-\[(#|rgb|hsl|oklch|color-mix|var|color:)/.test(utility),
    message:
      "Arbitrary value `{{token}}`: use the spacing and size scales, or a `--wc-*` token as `w-(--wc-…)`.",
  },
];

/** A class's utility: what follows its last variant (`hover:`, `data-[state=open]:`). */
function utilityOf(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start);
}

/** A string that looks like a class list: every token is utility-shaped and one has a dash. */
function classTokens(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  if (!tokens.every((t) => /^[!a-z0-9:_\-[\]().%#/,=&>*@'"]+$/i.test(t))) return [];
  if (!tokens.some((t) => /[-:]/.test(t))) return [];
  return tokens;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description: "Class lists use only the design system's type, color, radius and size scales.",
    },
    schema: [],
  },
  create(context) {
    function check(node, text) {
      for (const token of classTokens(text)) {
        const utility = utilityOf(token);
        for (const c of CHECKS) {
          if (c.re.test(utility) && (!c.test || c.test(utility))) {
            context.report({ node, message: c.message, data: { token } });
          }
        }
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default { rules: { "design-tokens": rule } };
