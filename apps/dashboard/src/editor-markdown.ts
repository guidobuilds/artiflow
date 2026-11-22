import type { ChainedCommands, Editor } from "@tiptap/core";

export { markdown, markdownExtensions } from "@artiflow/domain/markdown-doc";

type Action = {
  label: string;
  command: string;
  icon:
    | "undo"
    | "redo"
    | "doc"
    | "bold"
    | "italic"
    | "strike"
    | "code"
    | "list"
    | "sort"
    | "check"
    | "link"
    | "image"
    | "grid"
    | "divider"
    | "quote";
  run: (chain: ChainedCommands, url: string) => ChainedCommands;
  active?: (editor: Editor) => boolean;
};
type BlockType = Action & { schema: string; attrs?: { level: number } };
export const blockTypes: BlockType[] = [
  { label: "Paragraph", command: "setParagraph", schema: "paragraph", icon: "doc", run: (c) => c.setParagraph() },
  ...([1, 2, 3] as const).map((level): BlockType => ({
    label: `Heading ${level}`,
    command: "setHeading",
    schema: "heading",
    attrs: { level },
    icon: "doc",
    run: (c) => c.setHeading({ level }),
  })),
  {
    label: "Quote",
    command: "toggleBlockquote",
    schema: "blockquote",
    icon: "quote",
    run: (c) => c.toggleBlockquote(),
  },
  {
    label: "Code block",
    command: "toggleCodeBlock",
    schema: "codeBlock",
    icon: "code",
    run: (c) => c.toggleCodeBlock(),
  },
];
export function currentBlockType(editor: Editor): string {
  return (
    [...blockTypes.slice(1), blockTypes[0]!].find((entry) => editor.isActive(entry.schema, entry.attrs))?.label ??
    "Paragraph"
  );
}

export const toolbarGroups: { label: string; entries: Action[] }[] = [
  {
    label: "History",
    entries: [
      { label: "Undo", command: "undo", icon: "undo", run: (c) => c.undo() },
      { label: "Redo", command: "redo", icon: "redo", run: (c) => c.redo() },
    ],
  },
  { label: "Block type", entries: [{ label: "Block type", command: "blockType", icon: "doc", run: (c) => c }] },
  {
    label: "Text formatting",
    entries: [
      {
        label: "Bold",
        command: "toggleBold",
        icon: "bold",
        run: (c) => c.toggleBold(),
        active: (e) => e.isActive("bold"),
      },
      {
        label: "Italic",
        command: "toggleItalic",
        icon: "italic",
        run: (c) => c.toggleItalic(),
        active: (e) => e.isActive("italic"),
      },
      {
        label: "Strikethrough",
        command: "toggleStrike",
        icon: "strike",
        run: (c) => c.toggleStrike(),
        active: (e) => e.isActive("strike"),
      },
      {
        label: "Inline code",
        command: "toggleCode",
        icon: "code",
        run: (c) => c.toggleCode(),
        active: (e) => e.isActive("code"),
      },
    ],
  },
  {
    label: "Lists",
    entries: [
      {
        label: "Bulleted list",
        command: "toggleBulletList",
        icon: "list",
        run: (c) => c.toggleBulletList(),
        active: (e) => e.isActive("bulletList"),
      },
      {
        label: "Numbered list",
        command: "toggleOrderedList",
        icon: "sort",
        run: (c) => c.toggleOrderedList(),
        active: (e) => e.isActive("orderedList"),
      },
      {
        label: "Checklist",
        command: "toggleTaskList",
        icon: "check",
        run: (c) => c.toggleTaskList(),
        active: (e) => e.isActive("taskList"),
      },
    ],
  },
  {
    label: "Insert",
    entries: [
      {
        label: "Link",
        command: "setLink",
        icon: "link",
        run: (c, href) => c.setLink({ href }),
        active: (e) => e.isActive("link"),
      },
      { label: "Image", command: "setImage", icon: "image", run: (c, src) => c.setImage({ src }) },
      {
        label: "Table",
        command: "insertTable",
        icon: "grid",
        run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
        active: (e) => e.isActive("table"),
      },
      { label: "Divider", command: "setHorizontalRule", icon: "divider", run: (c) => c.setHorizontalRule() },
    ],
  },
];
