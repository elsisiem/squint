import { describe, expect, it } from "vitest";
import { ipBucket } from "../src/lib/util";

describe("ipBucket", () => {
  it("keeps IPv4 whole", () => expect(ipBucket("203.0.113.7")).toBe("203.0.113.7"));
  it("buckets IPv6 by /64, however it is written", () => {
    const a = ipBucket("2001:db8:1::1");
    expect(a).toBe(ipBucket("2001:0db8:0001:0000:aaaa:bbbb:cccc:dddd"));
    expect(a).toBe(ipBucket("2001:DB8:1:0:0:0:0:2"));
    expect(ipBucket("2001:db8:1:1::1")).not.toBe(a);
    expect(ipBucket("::1")).toBe("0:0:0:0::/64");
  });
  it("unwraps IPv4-mapped IPv6", () => expect(ipBucket("::ffff:203.0.113.7")).toBe("203.0.113.7"));
  it("leaves junk alone", () => expect(ipBucket("local")).toBe("local"));
});
