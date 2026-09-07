// The dashboard's backend answers only the loopback dev-server host, and
// browser requests must be same-origin (ADR 0005). One shared guard so every
// API middleware enforces the identical gate rather than copying it: null
// means pass; anything else is the response part to send back.

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Splits "localhost:4051" into "localhost" and "[::1]:4051" into "[::1]",
// respecting the bracket form IPv6 hosts arrive in.
const hostnameOf = (host) => {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1) || host;
  return host.split(":")[0];
};

export const gateRejection = ({ host, origin }) => {
  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(host)))
    return {
      status: 403,
      json: {
        error: "forbidden_host",
        message: "the dashboard API answers only the loopback dev-server host",
      },
    };

  if (origin !== undefined) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "\u0000unparsable";
    }
    if (originHost !== host)
      return {
        status: 403,
        json: {
          error: "cross_origin",
          message: "browser requests to the dashboard API must be same-origin",
        },
      };
  }

  return null;
};
