import { describe, it, expect } from "vitest";
import { createExternalResearcher } from "../src/generation/createExternalResearcher";
import { DossierExternalResearcher } from "../src/generation/DossierExternalResearcher";
import { NullExternalResearcher } from "../src/generation/NullExternalResearcher";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { RoutingConfigError, routeFor } from "../src/config/stageRouting";

/**
 * GV-61 (W3-16 test plan): the research route matrix. FORAY_STAGE_RESEARCH
 * picks none | stub | anthropic | dossier (built since GV-69); local mode defaults to 'none'
 * (OQ-04); with no routing variable set the choice is today's (Stub without
 * ANTHROPIC_API_KEY, Anthropic with it). There is no FORAY_RESEARCHER
 * variable (decision 4). Offline: the anthropic route is asserted through the
 * routing table and never constructed.
 */

const LLM = "http://127.0.0.1:4000";

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

describe("createExternalResearcher: the research route matrix (GV-61)", () => {
  /* MUTATION THAT KILLS THIS: build the Null researcher for the 'stub'
     built-in. Ran: red (this, the stub-with-key row, the local-mode override
     and the FORAY_RESEARCHER row). */
  it("no routing variable and no key: the Stub, exactly as today", () => {
    expect(createExternalResearcher({})).toBeInstanceOf(StubExternalResearcher);
  });

  /* MUTATION THAT KILLS THIS: have buildRoute return provider 'stub' for an
     anthropic spec. Ran: red (this and the FORAY_STAGE_RESEARCH=anthropic
     row). */
  /* GV-68: ANTHROPIC_API_KEY alone selects the Stub now; the anthropic route
     needs both legacy opt-ins. */
  it("the two legacy opt-ins and no stage variable: the anthropic route", () => {
    expect(routeFor("research", { ANTHROPIC_API_KEY: "sk-test" })?.provider).toBe("stub");
    expect(routeFor("research", { FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", ANTHROPIC_API_KEY: "sk-test" })?.provider).toBe("anthropic");
  });

  /* MUTATION THAT KILLS THIS: build the Stub for the 'none' built-in. Ran:
     red (this and the local-mode default). */
  it("FORAY_STAGE_RESEARCH=none builds the Null researcher, even with a key present", () => {
    const researcher = createExternalResearcher({ FORAY_STAGE_RESEARCH: "none", ANTHROPIC_API_KEY: "sk-test" });
    expect(researcher).toBeInstanceOf(NullExternalResearcher);
    expect(researcher.providerName).toBe("none");
    expect(researcher.retrievePassages).toBeUndefined();
  });

  it("FORAY_STAGE_RESEARCH=stub builds the Stub, even with a key present", () => {
    expect(createExternalResearcher({ FORAY_STAGE_RESEARCH: "stub", ANTHROPIC_API_KEY: "sk-test" })).toBeInstanceOf(StubExternalResearcher);
  });

  it("FORAY_STAGE_RESEARCH=anthropic routes to the legacy web researcher", () => {
    expect(routeFor("research", { FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", FORAY_STAGE_RESEARCH: "anthropic", ANTHROPIC_API_KEY: "sk-test" })?.provider).toBe("anthropic");
  });

  it("local mode defaults research to 'none' (OQ-04), and FORAY_STAGE_RESEARCH overrides it", () => {
    expect(createExternalResearcher({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: LLM })).toBeInstanceOf(NullExternalResearcher);
    expect(createExternalResearcher({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_RESEARCH: "stub" })).toBeInstanceOf(
      StubExternalResearcher
    );
  });

  /* GV-69 replaced GV-61's "not built" row: the dossier researcher is
     registered now. MUTATION THAT KILLS THIS: register a 'dossier'
     implementation in createExternalResearcher's BUILTINS that builds the
     Null researcher (a silent stand-in). Ran: red. */
  it("FORAY_STAGE_RESEARCH=dossier builds the dossier researcher (GV-69), even with a key present", () => {
    const researcher = createExternalResearcher({ FORAY_STAGE_RESEARCH: "dossier", ANTHROPIC_API_KEY: "sk-test" });
    expect(researcher).toBeInstanceOf(DossierExternalResearcher);
    expect(researcher.providerName).toBe("dossier");
    expect(typeof researcher.retrievePassages).toBe("function");
  });

  /* MUTATION THAT KILLS THIS: allow 'local' for research in ALLOWED_PROVIDERS
     and register a 'local' built-in. Ran: red (no throw). Allowing it without
     a registration is still refused, by the registry. */
  it("research has no 'local' route: FORAY_STAGE_RESEARCH=local is refused naming the variable", () => {
    const err = thrown(() => createExternalResearcher({ FORAY_STAGE_RESEARCH: "local", FORAY_LLM_BASE_URL: LLM }));
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("FORAY_STAGE_RESEARCH");
  });

  /* MUTATION THAT KILLS THIS: have createExternalResearcher honour
     FORAY_RESEARCHER=none before the routing table. Ran: red. */
  it("there is no FORAY_RESEARCHER variable (decision 4): it changes nothing", () => {
    expect(createExternalResearcher({ FORAY_RESEARCHER: "none" })).toBeInstanceOf(StubExternalResearcher);
  });
});
