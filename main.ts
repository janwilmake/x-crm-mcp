/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />

import { DurableObject } from "cloudflare:workers";
import { withSimplerAuth, UserContext } from "simplerauth-client";
import { withMcp } from "with-mcp";
//@ts-ignore
import openapi from "./openapi.json";

export interface Env {
  CRMDURABLEOBJECT: DurableObjectNamespace<CrmDurableObject>;
  TWITTER_API_KEY: string;
}

// User's CRM data storage
export class CrmDurableObject extends DurableObject<Env> {
  sql: SqlStorage;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    this.env = env;
  }

  async initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS follows (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        name TEXT,
        profile_image_url TEXT,
        description TEXT,
        followers_count INTEGER,
        following_count INTEGER,
        verified_type TEXT,
        is_blue_verified INTEGER,
        location TEXT,
        created_at TEXT,
        note TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async syncFollows(username: string) {
    await this.initSchema();

    // Get user's follows from Twitter API
    const followsResponse = await fetch(
      `https://api.twitterapi.io/twitter/user/followings?userName=${username}`,
      {
        headers: {
          "X-API-Key": this.env.TWITTER_API_KEY,
        },
      }
    );

    if (!followsResponse.ok) {
      throw new Error(`Failed to fetch follows: ${followsResponse.status}`);
    }

    const followsData = await followsResponse.json();
    const follows = followsData.followings || [];

    // Clear existing follows and insert new ones
    this.sql.exec("DELETE FROM follows");

    for (const follow of follows) {
      this.sql.exec(
        `INSERT OR REPLACE INTO follows 
         (user_id, username, name, profile_image_url, description, 
          followers_count, following_count, verified_type, is_blue_verified, 
          location, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        follow.id,
        follow.userName,
        follow.name,
        follow.profilePicture,
        follow.description,
        follow.followers,
        follow.following,
        follow.verifiedType,
        follow.isBlueVerified ? 1 : 0,
        follow.location,
        follow.createdAt
      );
    }

    // Continue pagination if needed
    let cursor = followsData.next_cursor;
    while (cursor && followsData.has_next_page) {
      const nextResponse = await fetch(
        `https://api.twitterapi.io/twitter/user/followings?userName=${username}&cursor=${cursor}`,
        {
          headers: {
            "X-API-Key": this.env.TWITTER_API_KEY,
          },
        }
      );

      if (!nextResponse.ok) break;

      const nextData = await nextResponse.json();
      const nextFollows = nextData.followings || [];

      for (const follow of nextFollows) {
        this.sql.exec(
          `INSERT OR REPLACE INTO follows 
           (user_id, username, name, profile_image_url, description, 
            followers_count, following_count, verified_type, is_blue_verified, 
            location, created_at) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          follow.id,
          follow.userName,
          follow.name,
          follow.profilePicture,
          follow.description,
          follow.followers,
          follow.following,
          follow.verifiedType,
          follow.isBlueVerified ? 1 : 0,
          follow.location,
          follow.createdAt
        );
      }

      cursor = nextData.next_cursor;
      if (!nextData.has_next_page) break;
    }

    return { synced: follows.length };
  }

  async getFollows() {
    await this.initSchema();
    const result = this.sql.exec(`
      SELECT user_id, username, name, profile_image_url, description,
             followers_count, following_count, verified_type, is_blue_verified,
             location, created_at, note, synced_at
      FROM follows 
      ORDER BY followers_count DESC
    `);
    return result.toArray();
  }

  async setNote(username: string, note: string) {
    await this.initSchema();
    const result = this.sql.exec(
      `UPDATE follows SET note = ? WHERE username = ?`,
      note,
      username
    );
    return { updated: result.rowsWritten > 0 };
  }
}

export default {
  fetch: withMcp(
    withSimplerAuth(
      async (request: Request, env: Env, ctx: UserContext) => {
        const url = new URL(request.url);

        // Ensure required env vars
        if (!env.TWITTER_API_KEY) {
          return new Response("TWITTER_API_KEY not configured", {
            status: 500,
          });
        }

        // Get user's Durable Object
        const getUserDO = () => {
          if (!ctx.user?.id) {
            throw new Error("User not authenticated");
          }
          return env.CRMDURABLEOBJECT.get(
            env.CRMDURABLEOBJECT.idFromName(ctx.user.id)
          );
        };

        // Sync follows endpoint
        if (url.pathname === "/sync") {
          if (!ctx.authenticated) {
            return new Response("Authentication required", { status: 401 });
          }

          try {
            const userDO = getUserDO();
            const result = await userDO.syncFollows(ctx.user?.username);

            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Get follows endpoint
        if (url.pathname === "/follows" && request.method === "GET") {
          if (!ctx.authenticated) {
            return new Response("Authentication required", { status: 401 });
          }

          try {
            const userDO = getUserDO();
            const follows = await userDO.getFollows();

            return new Response(JSON.stringify({ follows }, undefined, 2), {
              headers: { "Content-Type": "application/json;charset=utf8" },
            });
          } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Set note endpoint
        if (url.pathname.startsWith("/note/") && request.method === "POST") {
          if (!ctx.authenticated) {
            return new Response("Authentication required", { status: 401 });
          }

          const username = url.pathname.split("/note/")[1];
          const note = url.searchParams.get("note") || "";

          if (!username) {
            return new Response(
              JSON.stringify({ error: "Username required" }),
              {
                status: 400,
                headers: { "Content-Type": "application/json" },
              }
            );
          }

          try {
            const userDO = getUserDO();
            const result = await userDO.setNote(username, note);

            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Auth check endpoint for MCP
        if (url.pathname === "/me" && request.method === "GET") {
          if (!ctx.authenticated) {
            return new Response("Authentication required", { status: 401 });
          }

          return new Response(
            JSON.stringify({
              user: ctx.user,
              authenticated: true,
            }),
            {
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        return new Response(
          `
          <html>
            <head><title>X CRM MCP</title></head>
            <body>
              <h1>X CRM MCP Server</h1>
              ${
                ctx.authenticated
                  ? `
                <p>Welcome, ${ctx.user.name}!</p>

                <p><a href="/logout">Logout</a></p>
                <p><a href="/sync">Sync again</a></p>
                <p><a href="/follows">Get Follows</a></p>
                <p>MCP endpoint: <code>${url.origin}/mcp</code></p>
               
              `
                  : `
                <p><a href="/authorize?redirect_to=/sync">Login with X</a></p>
              `
              }
            </body>
          </html>
        `,
          {
            headers: { "Content-Type": "text/html" },
          }
        );
      },
      { isLoginRequired: false }
    ),
    openapi,
    {
      serverInfo: {
        name: "X CRM MCP Server",
        version: "1.0.0",
      },
      authEndpoint: "/me",
      toolOperationIds: ["getFollows", "setNote"],
      promptOperationIds: [],
      resourceOperationIds: [],
    }
  ),
} satisfies ExportedHandler<Env>;
