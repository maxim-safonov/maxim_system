import { requireEnv } from "./env.ts";

const notionApiKey = requireEnv("NOTION_API_KEY");
const notionVersion = "2026-03-11";

type NotionPageCreateResult = {
  id: string;
  url?: string;
};

type NotionDetails = {
  label: string;
  value: string;
};

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${notionApiKey}`,
    "Notion-Version": notionVersion,
    "Content-Type": "application/json",
  };
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
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
  details?: NotionDetails[];
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

  for (const detail of input.details ?? []) {
    if (!detail.value.trim()) {
      continue;
    }

    children.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `${detail.label}: ${detail.value}`,
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
              content: `Исходное сообщение: ${input.originalText}`,
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
    throw new Error(
      `Notion API error: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  return body as NotionPageCreateResult;
}

export async function updatePageTitle(input: {
  pageId: string;
  title: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.notion.com/v1/pages/${input.pageId}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
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
      }),
    },
  );

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Notion API error: ${response.status} ${JSON.stringify(body)}`,
    );
  }
}

export async function appendPageUpdate(input: {
  blockId: string;
  summary?: string | null;
  sourceId: string;
  originalText?: string | null;
  details?: NotionDetails[];
}): Promise<void> {
  const children: Record<string, unknown>[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [
          {
            type: "text",
            text: {
              content: "Обновление",
            },
          },
        ],
      },
    },
  ];

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

  for (const detail of input.details ?? []) {
    if (!detail.value.trim()) {
      continue;
    }

    children.push({
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [
          {
            type: "text",
            text: {
              content: `${detail.label}: ${detail.value}`,
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
              content: `Уточнение пользователя: ${input.originalText}`,
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

  const response = await fetch(
    `https://api.notion.com/v1/blocks/${input.blockId}/children`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ children }),
    },
  );

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      `Notion API error: ${response.status} ${JSON.stringify(body)}`,
    );
  }
}
