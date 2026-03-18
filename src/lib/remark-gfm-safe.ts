/**
 * A GFM remark plugin that supports tables, strikethrough, task lists and
 * footnotes — but intentionally omits autolink-literal.
 *
 * remark-gfm's autolink-literal extension uses a lookbehind regex
 * (/(?<=^|\s|\p{P}|\p{S})…/u) that throws on macOS ≤ 12 / WebKit < 16.4.
 * By assembling the other extensions manually we get full table/strike/task
 * support on every supported macOS version without the crash.
 */
import { combineExtensions } from "micromark-util-combine-extensions";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from "mdast-util-gfm-footnote";
import { gfmStrikethroughFromMarkdown, gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown, gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown, gfmTaskListItemToMarkdown } from "mdast-util-gfm-task-list-item";

export default function remarkGfmSafe(this: any) {
  const data = this.data() as Record<string, unknown[]>;

  function add(field: string, value: unknown) {
    const list = (data[field] ?? (data[field] = [])) as unknown[];
    list.push(value);
  }

  // micromark tokenizer extensions (no autolink-literal)
  add(
    "micromarkExtensions",
    combineExtensions([
      gfmFootnote(),
      gfmStrikethrough(),
      gfmTable(),
      gfmTaskListItem(),
    ])
  );

  // mdast (parse) extensions
  add("fromMarkdownExtensions", [
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  ]);

  // mdast (stringify) extensions
  add("toMarkdownExtensions", [
    gfmFootnoteToMarkdown(),
    gfmStrikethroughToMarkdown(),
    gfmTableToMarkdown(),
    gfmTaskListItemToMarkdown(),
  ]);
}
