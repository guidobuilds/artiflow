import { getSchema, type JSONContent } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

export const MARKDOWN_DOC_FIELD = "markdown";

export const markdownExtensions = [
  StarterKit.configure({ underline: false, link: { openOnClick: false } }),
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image,
  Markdown,
];

export const markdown = new MarkdownManager({ extensions: markdownExtensions });

export const markdownSchema = getSchema(markdownExtensions);

export function markdownToDoc(source: string): JSONContent {
  return markdown.parse(source);
}

export function docToMarkdown(doc: JSONContent): string {
  return markdown.serialize(doc);
}

export function readMarkdownFromFragment(fragment: Y.XmlFragment): string {
  return docToMarkdown(yXmlFragmentToProsemirrorJSON(fragment) as unknown as JSONContent);
}

export function replaceMarkdownInFragment(fragment: Y.XmlFragment, source: string): void {
  const doc = markdownToDoc(source);
  if (Array.isArray(doc.content) && doc.content.length > 0) {
    prosemirrorJSONToYXmlFragment(markdownSchema, doc, fragment);
    return;
  }
  if (fragment.length > 0) fragment.delete(0, fragment.length);
}
