import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Api } from "../api.js";
import { handle } from "./common.js";

// Orders, and the creator's decision on a payment that needs a person to look at it.

const orderId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).describe("The order id.");

export function registerOrderTools(server: McpServer, api: Api) {
  server.registerTool(
    "list_orders",
    {
      title: "List Orders",
      description:
        "The account's orders, newest first, ten a page. 'hold' are payments waiting for the creator's decision (confirm_payment / reject_payment).",
      inputSchema: {
        status: z.enum(["all", "pending", "hold", "delivered", "expired", "rejected"]).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handle(({ status, cursor }: { status?: string; cursor?: string }) => {
      const search = new URLSearchParams();
      if (status) search.set("status", status);
      if (cursor) search.set("cursor", cursor);
      return api.get(`/api/orders${search.size ? `?${search}` : ""}`);
    }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get Order",
      description:
        "One order, with the payment under review if there is one. For a pool, `order.quantity` is how many items were bought and `poolCodes.owed` how many the pool still owes (add items to serve them); the items themselves are never shown to an API key.",
      inputSchema: { orderId },
      annotations: { readOnlyHint: true },
    },
    handle(({ orderId }: { orderId: string }) => api.get(`/api/orders/${orderId}`)),
  );

  server.registerTool(
    "confirm_payment",
    {
      title: "Confirm Payment",
      description:
        "Confirm that a payment on hold belongs to this order: the consumer gets what they bought and the sales fee is charged. " +
        "Only do this after the creator has said so; it can't be undone.",
      inputSchema: { orderId },
      annotations: { destructiveHint: true },
    },
    handle(({ orderId }: { orderId: string }) => api.post(`/api/orders/${orderId}/confirm`)),
  );

  server.registerTool(
    "reject_payment",
    {
      title: "Reject Payment",
      description: "Reject a payment on hold: the order is not delivered. Only do this after the creator has said so; it can't be undone.",
      inputSchema: { orderId },
      annotations: { destructiveHint: true },
    },
    handle(({ orderId }: { orderId: string }) => api.post(`/api/orders/${orderId}/reject`)),
  );
}
