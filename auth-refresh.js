#!/usr/bin/env node
/**
 * Fixes v2.1.112 auth token issues by refreshing expired/invalid tokens.
 *
 * The API changed token validation, and v2.1.112 doesn't refresh on 401.
 * This module intercepts auth failures and refreshes using the stored refreshToken.
 */

import fs from "fs";
import path from "path";
import os from "os";
import https from "https";

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const API_ENDPOINT = "https://api.anthropic.com";

export async function refreshAccessToken() {
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { refreshToken } = credentials.claudeAiOauth || {};

    if (!refreshToken) {
      console.error("No refreshToken found in credentials");
      return null;
    }

    console.error("[auth-refresh] Attempting to refresh token...");

    const response = await fetch(`${API_ENDPOINT}/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshToken}`,
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      console.error(
        `[auth-refresh] Token refresh failed: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
    const newToken = data.accessToken || data.access_token;

    if (!newToken) {
      console.error("[auth-refresh] No accessToken in refresh response");
      return null;
    }

    // Update credentials file
    credentials.claudeAiOauth.accessToken = newToken;
    if (data.expiresIn) {
      credentials.claudeAiOauth.expiresAt = Date.now() + data.expiresIn * 1000;
    } else if (data.expires_in) {
      credentials.claudeAiOauth.expiresAt =
        Date.now() + data.expires_in * 1000;
    }

    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
    console.error("[auth-refresh] Token refreshed successfully");

    return newToken;
  } catch (error) {
    console.error(`[auth-refresh] Error refreshing token:`, error.message);
    return null;
  }
}

export function getStoredAccessToken() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      return null;
    }
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    return credentials.claudeAiOauth?.accessToken;
  } catch (error) {
    return null;
  }
}
