// Purpose Built seat counter + checkout for keedirection.com
//
// GET  /seats     -> { left, total, soldOut }   (reads live Square inventory)
// GET  /checkout  -> 302 redirect to a fresh Square checkout page (or back to the
//                    sign-up page with ?soldout=1 when no seats are left)
//
// Settings in Cloudflare (Settings > Variables and Secrets):
//   SQUARE_ACCESS_TOKEN  (Secret, REQUIRED)  Square production access token
// Everything below is optional; the defaults fit keedirection.com:
//   ITEM_NAME            default "Purpose Built" (Square item name to look for)
//   TOTAL_SEATS          default 16
//   SITE_ORIGIN          default https://keedirection.com
//   SIGNUP_PATH          default /purpose-built/
//   THANKS_PATH          default /purpose-built/thanks.html
//   SQUARE_LOCATION_ID / SQUARE_VARIATION_ID  only if auto-detect picks wrong

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2025-01-23";

async function square(env, path, init = {}) {
  const res = await fetch(`${SQUARE_API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Square ${res.status}: ${JSON.stringify(body.errors || body)}`);
  }
  return body;
}

// Finds the location and the class item's variation by itself, so the only
// setting you must add in Cloudflare is SQUARE_ACCESS_TOKEN.
let found = null;
async function ids(env) {
  if (found) return found;
  let location = env.SQUARE_LOCATION_ID;
  if (!location) {
    const { locations = [] } = await square(env, "/locations");
    const active = locations.find((l) => l.status === "ACTIVE") || locations[0];
    if (!active) throw new Error("No Square location found");
    location = active.id;
  }
  let variation = env.SQUARE_VARIATION_ID;
  if (!variation) {
    const name = env.ITEM_NAME || "Purpose Built";
    const { items = [] } = await square(env, "/catalog/search-catalog-items", {
      method: "POST",
      body: JSON.stringify({ text_filter: name }),
    });
    const item = items.find((i) => i.item_data && i.item_data.name &&
      i.item_data.name.toLowerCase().includes(name.toLowerCase()));
    const v = item && item.item_data.variations && item.item_data.variations[0];
    if (!v) throw new Error(`No Square item named like "${name}"`);
    variation = v.id;
  }
  found = { location, variation };
  return found;
}

async function seatsLeft(env) {
  const { location, variation } = await ids(env);
  const data = await square(env, `/inventory/${variation}?location_ids=${location}`);
  const inStock = (data.counts || []).find((c) => c.state === "IN_STOCK");
  const left = Math.max(0, Math.floor(Number(inStock ? inStock.quantity : 0)));
  const total = Number(env.TOTAL_SEATS || 16);
  return { left: Math.min(left, total), total, soldOut: left <= 0 };
}

function cors(env, extra = {}) {
  return {
    "Access-Control-Allow-Origin": env.SITE_ORIGIN || "https://keedirection.com",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
    ...extra,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(env) });
    }

    if (url.pathname === "/seats") {
      // Cache for 20 seconds so a busy page doesn't hammer Square.
      const cache = caches.default;
      const key = new Request(`${url.origin}/seats`);
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const seats = await seatsLeft(env);
        const res = new Response(JSON.stringify(seats), {
          headers: cors(env, {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=20",
          }),
        });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: "unavailable" }), {
          status: 502,
          headers: cors(env, { "Content-Type": "application/json" }),
        });
      }
    }

    if (url.pathname === "/checkout") {
      const site = env.SITE_ORIGIN || "https://keedirection.com";
      try {
        const { soldOut } = await seatsLeft(env);
        if (soldOut) {
          return Response.redirect(`${site}${env.SIGNUP_PATH || "/purpose-built/"}?soldout=1`, 302);
        }
        const { location, variation } = await ids(env);
        const link = await square(env, "/online-checkout/payment-links", {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: crypto.randomUUID(),
            order: {
              location_id: location,
              line_items: [{ catalog_object_id: variation, quantity: "1" }],
            },
            checkout_options: {
              redirect_url: `${site}${env.THANKS_PATH || "/purpose-built/thanks.html"}`,
              ask_for_shipping_address: false,
            },
          }),
        });
        return Response.redirect(link.payment_link.url, 302);
      } catch (err) {
        console.error(err);
        return Response.redirect(`${site}${env.SIGNUP_PATH || "/purpose-built/"}?error=1`, 302);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
