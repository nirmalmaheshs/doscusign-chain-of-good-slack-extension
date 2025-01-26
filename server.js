import express from "express";
import { WebClient } from "@slack/web-api";
import path from "path";
import { ModelManagerUtil } from "./utils/modelManagerUtil.js";
import { fileURLToPath } from "url";
import { dirname } from "path";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Standard error response format for DocuSign
const createErrorResponse = (status, code, message, details = null) => {
  const response = {
    error: code,
    message: message,
  };
  if (details) {
    response.details = details;
  }
  return response;
};

// Initialize model manager
const MODEL_MANAGER = ModelManagerUtil.createModelManagerFromCTO(
  path.join(__dirname, "./model.cto")
);
const CONCEPTS = MODEL_MANAGER.getConceptDeclarations();
const READABLE_CONCEPTS = CONCEPTS.filter((concept) =>
  concept
    .getDecorator("Crud")
    ?.getArguments()[0]
    ?.split(",")
    .includes("Readable")
);

// Middleware to validate authorization
const validateAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) {
    return res
      .status(401)
      .json(
        createErrorResponse(401, "UNAUTHORIZED", "Missing authorization header")
      );
  }
  req.slackToken = auth.replace(/^Bearer\s+/i, "");
  next();
};

// Transform DocuSign request to Slack format
const transformRequest = (docusignRequest) => {
  if (!docusignRequest.message) {
    throw new Error("Missing required fields");
  }

  return {
    channel: docusignRequest.channelId,
    text: docusignRequest.message,
    unfurl_links: false,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: docusignRequest.message,
        },
      },
    ],
  };
};

// GetTypeNames
app.post("/api/types/names", async (req, res) => {
  try {
    const typeNames = [
      { typeName: "Channel", label: "Channel" },
      { typeName: "Message", label: "Message" },
    ];
    res.json({ typeNames });
  } catch (error) {
    res
      .status(500)
      .json(
        createErrorResponse(
          500,
          "INTERNAL_ERROR",
          "Failed to retrieve type names",
          error.message
        )
      );
  }
});

// GetTypeDefinitions
app.post("/api/types/definitions", async (req, res) => {
  const { typeNames } = req.body;

  if (!typeNames || !Array.isArray(typeNames)) {
    return res
      .status(400)
      .json(
        createErrorResponse(
          400,
          "BAD_REQUEST",
          "Missing or invalid typeNames in request"
        )
      );
  }

  try {
    const declarations = READABLE_CONCEPTS.filter((concept) =>
      typeNames.includes(concept.getName())
    ).map((concept) => concept.ast);

    return res.json({ declarations });
  } catch (error) {
    return res
      .status(500)
      .json(
        createErrorResponse(
          500,
          "INTERNAL_ERROR",
          "Failed to get type definitions",
          error.message
        )
      );
  }
});

// Post /api/slack/channels endpoint
app.post("/api/slack/channels", validateAuth, async (req, res) => {
  const {
    body: { query, pagination },
  } = req;
  try {
    if (!query || !pagination) {
      return res
        .status(400)
        .json(
          createErrorResponse(
            400,
            "BAD_REQUEST",
            "Query or pagination missing in request"
          )
        );
    }

    const slack = new WebClient(req.slackToken);
    const result = await slack.conversations.list({
      types: "public_channel,private_channel",
      limit: pagination.limit,
      cursor: pagination.skip === 0 ? undefined : pagination.skip,
    });

    const records = result.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private,
    }));
    console.log({
      records,
      pagination: {
        next_cursor: result.response_metadata?.next_cursor,
      },
    });
    return res.json({
      records,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(error.code === "token_expired" ? 401 : 500)
      .json(
        createErrorResponse(
          error.code === "token_expired" ? 401 : 500,
          error.code === "token_expired" ? "UNAUTHORIZED" : "INTERNAL_ERROR",
          "Failed to fetch channels",
          error.message
        )
      );
  }
});

// Add this function to check and join channel
async function ensureBotInChannel(client, channelId) {
  try {
    // First try to join the channel directly
    // await client.conversations.join({ channel: channelId });
  } catch (error) {
    console.log("Error joining channel:", error.message);
    // If joining fails, the channel might be private, and we can't handle that automatically
    throw new Error(
      "Unable to join channel. For private channels, please add the bot manually."
    );
  }
}

// POST /api/slack/message endpoint
app.post("/api/slack/message", validateAuth, async (req, res) => {
  const {
    body: { data, typeName, idempotencyKey },
  } = req;
  try {
    if (!data || !typeName) {
      return res
        .status(400)
        .json(
          createErrorResponse(
            400,
            "BAD_REQUEST",
            "data or typeName missing in request"
          )
        );
    }

    const slack = new WebClient(req.slackToken);

    // Try to find the docusign-notifications channel
    let channelId;
    try {
      const channelList = await slack.conversations.list({
        types: "public_channel,private_channel",
      });
      const channel = channelList.channels.find(
        (ch) => ch.name === "docusign-notifications"
      );

      if (channel) {
        channelId = channel.id;
      } else {
        // Create the channel if it doesn't exist
        const newChannel = await slack.conversations.create({
          name: "docusign-notifications",
          is_private: false,
        });
        channelId = newChannel.channel.id;
        console.log("Created new channel:", newChannel);
      }
    } catch (error) {
      console.log("Error finding/creating channel:", error);
      throw error;
    }

    const slackRequest = {
      ...transformRequest(data),
      channel: channelId,
      app_hidden: false,
    };
    console.log(channelId);
    // Add this before sending the message
    await ensureBotInChannel(slack, channelId);

    const result = await slack.chat.postMessage(slackRequest);
    return res.json({
      recordId: result.ts,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(error.code === "token_expired" ? 401 : 500)
      .json(
        createErrorResponse(
          error.code === "token_expired" ? 401 : 500,
          error.code === "token_expired" ? "UNAUTHORIZED" : "INTERNAL_ERROR",
          "Failed to send message",
          error.message
        )
      );
  }
});

// PATCH /api/slack/message/update endpoint
app.patch("/api/slack/message/update", validateAuth, async (req, res) => {
  const { channelId, messageId, message } = req.body;

  if (!channelId || !messageId || !message) {
    return res
      .status(400)
      .json(createErrorResponse(400, "BAD_REQUEST", "Missing required fields"));
  }

  try {
    const slack = new WebClient(req.slackToken);
    const result = await slack.chat.update({
      channel: channelId,
      ts: messageId,
      text: message,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: message,
          },
        },
      ],
    });

    res.json({
      success: true,
      messageId: result.ts,
    });
  } catch (error) {
    res
      .status(error.code === "token_expired" ? 401 : 500)
      .json(
        createErrorResponse(
          error.code === "token_expired" ? 401 : 500,
          error.code === "token_expired" ? "UNAUTHORIZED" : "INTERNAL_ERROR",
          "Failed to update message",
          error.message
        )
      );
  }
});

// Global error handler
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res
    .status(500)
    .json(
      createErrorResponse(
        500,
        "INTERNAL_ERROR",
        "An unexpected error occurred",
        error.message
      )
    );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API Proxy running on port ${PORT}`);
});
