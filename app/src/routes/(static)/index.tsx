import { createFileRoute, Link } from "@tanstack/react-router";
import {
  GaugeIcon,
  GlobeIcon,
  LayersIcon,
  LinkIcon,
  TicketIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getSession } from "@/lib/auth";
import { clientEnv } from "@/lib/env-client";
import { m } from "@/paraglide/messages";
import { getPublicSettings } from "@/query/settings";

export const Route = createFileRoute("/(static)/")({
  beforeLoad: async () => {
    const [session, settings] = await Promise.all([
      getSession(),
      getPublicSettings(),
    ]);

    return {
      user: session?.user ?? null,
      settings,
    };
  },
  head: () => ({
    meta: [
      {
        title: m.landing_meta_title({ appName: clientEnv.VITE_APP_NAME }),
      },
      {
        name: "description",
        content: m.landing_meta_description(),
      },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  const { user, settings } = Route.useRouteContext();
  const appName = clientEnv.VITE_APP_NAME;
  const year = new Date().getFullYear();
  const isSignedIn = user !== null;
  const isAdmin = user?.role === "admin";
  const signUpOpen = settings.registrationMode === "open";

  const features = [
    {
      icon: LayersIcon,
      title: m.landing_feature_protocols_title(),
      description: m.landing_feature_protocols_description(),
    },
    {
      icon: LinkIcon,
      title: m.landing_feature_subscription_title(),
      description: m.landing_feature_subscription_description(),
    },
    {
      icon: GaugeIcon,
      title: m.landing_feature_traffic_title(),
      description: m.landing_feature_traffic_description(),
    },
    {
      icon: GlobeIcon,
      title: m.landing_feature_nodes_title(),
      description: m.landing_feature_nodes_description(),
    },
    {
      icon: TicketIcon,
      title: m.landing_feature_redeem_title(),
      description: m.landing_feature_redeem_description(),
    },
  ];

  const steps = [
    {
      title: m.landing_step_1_title(),
      description: m.landing_step_1_description(),
    },
    {
      title: m.landing_step_2_title(),
      description: m.landing_step_2_description(),
    },
    {
      title: m.landing_step_3_title(),
      description: m.landing_step_3_description(),
    },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img
              src="/icons/blossom.png"
              alt=""
              width={28}
              height={28}
              className="size-7 rounded-md"
            />
            <span>{appName}</span>
          </Link>

          <nav className="flex items-center gap-2">
            {isSignedIn ? (
              <>
                {isAdmin ? (
                  <Button variant="ghost" render={<Link to="/admin" />}>
                    {m.landing_nav_admin()}
                  </Button>
                ) : null}
                <Button render={<Link to="/dashboard" />}>
                  {m.landing_nav_dashboard()}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" render={<Link to="/auth/login" />}>
                  {m.landing_nav_sign_in()}
                </Button>
                {signUpOpen ? (
                  <Button render={<Link to="/auth/signup" />}>
                    {m.landing_nav_sign_up()}
                  </Button>
                ) : null}
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-3xl px-4 py-16 text-center sm:py-24">
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            {m.landing_hero_title({ appName })}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-balance text-muted-foreground">
            {m.landing_hero_description()}
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {isSignedIn ? (
              <Button size="lg" render={<Link to="/dashboard" />}>
                {m.landing_hero_go_dashboard()}
              </Button>
            ) : (
              <>
                {signUpOpen ? (
                  <Button size="lg" render={<Link to="/auth/signup" />}>
                    {m.landing_nav_sign_up()}
                  </Button>
                ) : null}
                <Button
                  size="lg"
                  variant={signUpOpen ? "outline" : "default"}
                  render={<Link to="/auth/login" />}
                >
                  {m.landing_nav_sign_in()}
                </Button>
              </>
            )}
          </div>

          {!isSignedIn && !signUpOpen ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {m.landing_registration_closed()}
            </p>
          ) : null}
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-16">
          <h2 className="mb-6 text-center text-2xl font-semibold tracking-tight">
            {m.landing_features_title()}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.title}>
                <CardHeader>
                  <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-muted text-foreground">
                    <feature.icon className="size-5" aria-hidden />
                  </div>
                  <CardTitle>{feature.title}</CardTitle>
                  <CardDescription>{feature.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-t bg-muted/40">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="mb-10 text-center text-2xl font-semibold tracking-tight">
              {m.landing_how_title()}
            </h2>
            <ol className="grid gap-8 md:grid-cols-3">
              {steps.map((step, index) => (
                <li key={step.title} className="flex flex-col gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
                  >
                    {index + 1}
                  </span>
                  <h3 className="text-lg font-semibold">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>{m.landing_footer_copyright({ year, appName })}</p>
          {settings.supportUrl || settings.supportEmail ? (
            <nav className="flex flex-wrap gap-x-6 gap-y-2">
              {settings.supportUrl ? (
                <a
                  href={settings.supportUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground"
                >
                  {m.landing_footer_support()}
                </a>
              ) : null}
              {settings.supportEmail ? (
                <a
                  href={`mailto:${settings.supportEmail}`}
                  className="hover:text-foreground"
                >
                  {m.landing_footer_email_support()}
                </a>
              ) : null}
            </nav>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
