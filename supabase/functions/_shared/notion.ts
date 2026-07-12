import { requireEnv } from "./env.ts";

const notionApiKey = requireEnv("NOTION_API_KEY");
const notionVersion = "2026-03-11";

type NotionPageCreateResult = {
  id: string;
  url?: string;
};

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${notionApiKey}`,
    "Notion-Version": notionVersion,
    "Content-Type": "application/json",
  };
}

export function parseNotionTargets(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as Record<string, string>;
  return parsed;
}

export async function createChildPage(input: {
  parentPageId: string;
  title: string;
  summary?: string | null;
  sourceId: string;
  originalText?: string | null;
}): Promise<NotionPageCreateResult> {
  const children: Record<string, unknown>[] = [];

  if (input.summary) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: input.summary,
            },
          },
        ],
      },
    });
  }

  if (input.originalText && input.originalText !== input.summary) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `Original: ${input.originalText}`,
            },
          },
        ],
      },
    });
  }

  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: {
            content: `Life OS source id: ${input.sourceId}`,
          },
        },
      ],
    },
  });

  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: {
        page_id: input.parentPageId,
      },
      properties: {
        title: {
          title: [
            {
              type: "text",
              text: {
                content: input.title,
              },
            },
          ],
        },
      },
      children,
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Notion API error: ${response.status} ${JSON.stringify(body)}`);
  }

  return body as NotionPageCreateResult;
}
