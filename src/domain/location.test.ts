import { describe, expect, test } from "bun:test";
import { describePlace, fromNominatim, placeOf } from "./location.ts";

describe("a place Nominatim found", () => {
  const row = { lat: "50.0821569", lon: "14.4573253", name: "Kutil Gym", display_name: "Kutil Gym, Táboritská, Žižkov, obvod Praha 3, Praha, 130 00, Česko" };

  test("the name is the title and is not repeated in the address", () => {
    const place = fromNominatim(row, "kutil gym praha");
    expect(place).toEqual({ latitude: 50.0821569, longitude: 14.4573253, title: "Kutil Gym", address: "Táboritská, Žižkov, obvod Praha 3, Praha, 130 00, Česko" });
  });

  test("with no name of its own, the first part of the address becomes the title", () => {
    const place = fromNominatim({ lat: "1", lon: "2", display_name: "Táboritská 1, Praha" }, "táboritská 1");
    expect(place.title).toBe("Táboritská 1");
    expect(place.address).toBe("Praha");
  });

  test("nothing but coordinates still yields a place, titled by what was asked for", () => {
    expect(fromNominatim({ lat: "1.5", lon: "-2.5" }, "somewhere")).toEqual({ latitude: 1.5, longitude: -2.5, title: "somewhere", address: undefined });
  });
});

describe("a location he sent", () => {
  test("a venue becomes a place with its name and address", () => {
    const place = placeOf({ venue: { location: { latitude: 50.08, longitude: 14.45 }, title: "Kutil Gym", address: "Táboritská, Praha" } });
    expect(place).toEqual({ latitude: 50.08, longitude: 14.45, title: "Kutil Gym", address: "Táboritská, Praha" });
    expect(describePlace(place!)).toBe("[location: Kutil Gym · Táboritská, Praha · 50.08000,14.45000 · https://www.google.com/maps/search/?api=1&query=50.08000,14.45000]");
  });

  test("a bare pin is just the point", () => {
    expect(placeOf({ location: { latitude: 50.08, longitude: 14.45 } })).toEqual({ latitude: 50.08, longitude: 14.45, title: undefined, address: undefined });
  });

  test("a live location says so", () => {
    expect(placeOf({ location: { latitude: 1, longitude: 2, live_period: 900 } })?.title).toBe("live location");
  });

  test("a message with no place at all is nothing, so nothing is rendered for it", () => {
    expect(placeOf({})).toBeUndefined();
  });
});
