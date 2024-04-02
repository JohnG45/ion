import fs from "fs";
import path from "path";
import type { BuildMetaConfig, BuildMetaFileName } from "astro-sst/build-meta";
import { ComponentResourceOptions, Output, all, output } from "@pulumi/pulumi";
import { Function } from "./function.js";
import {
  Plan,
  SsrSiteArgs,
  createBucket,
  createServersAndDistribution,
  prepare,
  useCloudFrontFunctionHostHeaderInjection,
  validatePlan,
} from "./ssr-site.js";
import { Cdn } from "./cdn.js";
import { Bucket } from "./bucket.js";
import { Component, transform } from "./../component.js";
import { Hint } from "./../hint.js";
import { Link } from "../link.js";
import { Cache } from "./providers/cache.js";
import { buildApp } from "../base/base-ssr-site.js";

export interface AstroArgs extends SsrSiteArgs {
  /**
   * The number of instances of the [server function](#nodes-server) to keep warm. This is useful for cases where you are experiencing long cold starts. The default is to not keep any instances warm.
   *
   * This works by starting a serverless cron job to make _n_ concurrent requests to the server function every few minutes. Where _n_ is the number of instances to keep warm.
   *
   * @default `0`
   */
  warm?: SsrSiteArgs["warm"];
  /**
   * Permissions and the resources that the [server function](#nodes-server) in your Astro site needs to access. These permissions are used to create the function's IAM role.
   *
   * :::tip
   * If you `link` the function to a resource, the permissions to access it are
   * automatically added.
   * :::
   *
   * @example
   * Allow reading and writing to an S3 bucket called `my-bucket`.
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:GetObject", "s3:PutObject"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     },
   *   ]
   * }
   * ```
   *
   * Perform all actions on an S3 bucket called `my-bucket`.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["s3:*"],
   *       resources: ["arn:aws:s3:::my-bucket/*"]
   *     },
   *   ]
   * }
   * ```
   *
   * Grant permissions to access all resources.
   *
   * ```js
   * {
   *   permissions: [
   *     {
   *       actions: ["*"],
   *       resources: ["*"]
   *     },
   *   ]
   * }
   * ```
   */
  permissions?: SsrSiteArgs["permissions"];
  /**
   * Path to the directory where your Astro site is located.  This path is relative to your `sst.config.ts`.
   *
   * By default it assumes your Astro site is in the root of your SST app.
   * @default `"."`
   *
   * @example
   *
   * If your Astro site is in a package in your monorepo.
   *
   * ```js
   * {
   *   path: "packages/web"
   * }
   * ```
   */
  path?: SsrSiteArgs["path"];
  /**
   * [Link resources](/docs/linking/) to your Astro site. This will:
   *
   * 1. Grant the permissions needed to access the resources.
   * 2. Allow you to access it in your site using the [SDK](/docs/reference/sdk/).
   *
   * @example
   *
   * Takes a list of resources to link to the function.
   *
   * ```js
   * {
   *   link: [bucket, stripeKey]
   * }
   * ```
   */
  link?: SsrSiteArgs["link"];
  /**
   * Configure how the CloudFront cache invalidations are handled. This is run after your Astro site has been deployed.
   * :::tip
   * You get 1000 free invalidations per month. After that you pay $0.005 per invalidation path. [Read more here](https://aws.amazon.com/cloudfront/pricing/).
   * :::
   * @default `&lcub;paths: "all", wait: false&rcub;`
   * @example
   * Wait for all paths to be invalidated.
   * ```js
   * {
   *   invalidation: {
   *     paths: "all",
   *     wait: true
   *   }
   * }
   * ```
   */
  invalidation?: SsrSiteArgs["invalidation"];
  /**
   * Set [environment variables](https://docs.astro.build/en/guides/environment-variables/) in your Astro site. These are made available:
   *
   * 1. In `astro build`, they are loaded into `import.meta.env`.
   * 2. Locally while running `sst dev astro dev`.
   *
   * :::tip
   * You can also `link` resources to your Astro site and access them in a type-safe way with the [SDK](/docs/reference/sdk/). We recommend linking since it's more secure.
   * :::
   *
   * Recall that in Astro, you need to prefix your environment variables with `PUBLIC_` to access them on the client-side. [Read more here](https://docs.astro.build/en/guides/environment-variables/).
   *
   * @example
   * ```js
   * {
   *   environment: {
   *     API_URL: api.url,
   *     // Accessible on the client-side
   *     PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_123"
   *   }
   * }
   * ```
   */
  environment?: SsrSiteArgs["environment"];
  /**
   * Set a custom domain for your Astro site. Supports domains hosted either on
   * [Route 53](https://aws.amazon.com/route53/) or outside AWS.
   *
   * :::tip
   * You can also migrate an externally hosted domain to Amazon Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   * :::
   *
   * @example
   *
   * ```js
   * {
   *   domain: "domain.com"
   * }
   * ```
   *
   * Specify the Route 53 hosted zone and a `www.` version of the custom domain.
   *
   * ```js
   * {
   *   domain: {
   *     domainName: "domain.com",
   *     hostedZone: "domain.com",
   *     redirects: ["www.domain.com"]
   *   }
   * }
   * ```
   */
  domain?: SsrSiteArgs["domain"];
  /**
   * The command used internally to build your Astro site.
   *
   * @default `"npm run build"`
   *
   * @example
   *
   * If you want to use a different build command.
   * ```js
   * {
   *   buildCommand: "yarn build"
   * }
   * ```
   */
  buildCommand?: SsrSiteArgs["buildCommand"];
  /**
   * Configure how the Astro site assets are uploaded to S3.
   *
   * By default, this is set to the following. Read more about these options below.
   * ```js
   * {
   *   assets: {
   *     textEncoding: "utf-8",
   *     versionedFilesCacheHeader: "public,max-age=31536000,immutable",
   *     nonVersionedFilesCacheHeader: "public,max-age=0,s-maxage=86400,stale-while-revalidate=8640"
   *   }
   * }
   * ```
   */
  assets?: SsrSiteArgs["assets"];
}

const BUILD_META_FILE_NAME: BuildMetaFileName = "sst.buildMeta.json";

/**
 * The `Astro` component lets you deploy an [Astro](https://astro.build) site to AWS.
 *
 * @example
 *
 * #### Minimal example
 *
 * Deploy the Astro site that's in the project root.
 *
 * ```js
 * new sst.aws.Astro("MyWeb");
 * ```
 *
 * #### Change the path
 *
 * Deploys the Astro site in the `my-astro-app/` directory.
 *
 * ```js {2}
 * new sst.aws.Astro("MyWeb", {
 *   path: "my-astro-app/"
 * });
 * ```
 *
 * #### Add a custom domain
 *
 * Set a custom domain for your Astro site.
 *
 * ```js {2}
 * new sst.aws.Astro("MyWeb", {
 *   domain: "my-app.com"
 * });
 * ```
 *
 * #### Redirect www to apex domain
 *
 * Redirect `www.my-app.com` to `my-app.com`.
 *
 * ```js {4}
 * new sst.aws.Astro("MyWeb", {
 *   domain: {
 *     domainName: "my-app.com",
 *     redirects: ["www.my-app.com"]
 *   }
 * });
 * ```
 *
 * #### Link resources
 *
 * [Link resources](/docs/linking/) to your Astro site. This will grant permissions
 * to the resources and allow you to access it in your site.
 *
 * ```ts {4}
 * const bucket = new sst.aws.Bucket("MyBucket");
 *
 * new sst.aws.Astro("MyWeb", {
 *   link: [bucket]
 * });
 * ```
 *
 * You can use the [SDK](/docs/reference/sdk/) to access the linked resources
 * in your Astro site.
 *
 * ```astro title="src/pages/index.astro"
 * ---
 * import { Resource } from "sst";
 *
 * console.log(Resource.MyBucket.name);
 * ---
 * ```
 */
export class Astro extends Component implements Link.Linkable {
  private cdn: Output<Cdn>;
  private assets: Bucket;
  private server: Output<Function>;

  constructor(
    name: string,
    args: AstroArgs = {},
    opts: ComponentResourceOptions = {},
  ) {
    super(__pulumiType, name, args, opts);

    const parent = this;
    const { sitePath, partition, region } = prepare(args, opts);
    const { access, bucket } = createBucket(parent, name, partition, args);
    const outputPath = buildApp(name, args, sitePath);
    const { buildMeta } = loadBuildOutput();
    const plan = buildPlan();
    const { distribution, ssrFunctions, edgeFunctions } =
      createServersAndDistribution(
        parent,
        name,
        args,
        outputPath,
        access,
        bucket,
        plan,
      );
    const serverFunction = ssrFunctions[0] ?? Object.values(edgeFunctions)[0];

    this.assets = bucket;
    this.cdn = distribution;
    this.server = serverFunction;
    this.registerOutputs({
      _hint: $dev
        ? undefined
        : all([this.cdn.domainUrl, this.cdn.url]).apply(
            ([domainUrl, url]) => domainUrl ?? url,
          ),
      _metadata: {
        mode: $dev ? "placeholder" : "deployed",
        path: sitePath,
        url: distribution.apply((d) => d.domainUrl ?? d.url),
        edge: plan.edge,
        server: serverFunction.arn,
      },
    });

    function loadBuildOutput() {
      const cache = new Cache(
        `${name}BuildOutput`,
        {
          data: $dev ? loadBuildMetadataPlaceholder() : loadBuildMetadata(),
        },
        {
          parent,
          ignoreChanges: $dev ? ["*"] : undefined,
        },
      );

      return {
        buildMeta: cache.data as ReturnType<typeof loadBuildMetadata>,
      };
    }

    function loadBuildMetadata() {
      return outputPath.apply((outputPath) => {
        const filePath = path.join(outputPath, "dist", BUILD_META_FILE_NAME);
        if (!fs.existsSync(filePath)) {
          throw new Error(
            `Could not find build meta file at ${filePath}. Update your 'astro-sst' package version and rebuild your Astro site.`,
          );
        }
        return JSON.parse(
          fs.readFileSync(filePath, "utf-8"),
        ) as BuildMetaConfig;
      });
    }

    function loadBuildMetadataPlaceholder() {
      return {
        deploymentStrategy: "regional",
        responseMode: "buffer",
        outputMode: "server",
        pageResolution: "directory",
        trailingSlash: "ignore",
        serverBuildOutputFile: "dist/server/entry.mjs",
        clientBuildOutputDir: "dist/client",
        clientBuildVersionedSubDir: "_astro",
        routes: [
          {
            route: "/_image",
            type: "endpoint",
            pattern: "/^\\/_image$/",
            prerender: false,
          },
          {
            route: "/",
            type: "page",
            pattern: "/^\\/$/",
            prerender: false,
          },
        ],
        serverRoutes: [],
      };
    }

    function buildPlan() {
      return all([outputPath, buildMeta]).apply(([outputPath, buildMeta]) => {
        const isStatic = buildMeta.outputMode === "static";
        const edge = buildMeta.deploymentStrategy === "edge";
        const serverConfig = {
          handler: path.join(outputPath, "dist", "server", "entry.handler"),
        };
        const plan: Plan = {
          edge,
          cloudFrontFunctions: {
            serverCfFunction: {
              injections: [
                useCloudFrontFunctionHostHeaderInjection(),
                useCloudFrontRoutingInjection(buildMeta),
              ],
            },
            serverCfFunctionHostOnly: {
              injections: [useCloudFrontFunctionHostHeaderInjection()],
            },
          },
          origins: {
            staticsServer: {
              s3: {
                copy: [
                  {
                    from: buildMeta.clientBuildOutputDir,
                    to: "",
                    cached: true,
                    versionedSubDir: buildMeta.clientBuildVersionedSubDir,
                  },
                ],
              },
            },
          },
          behaviors: [],
          errorResponses: [],
        };

        if (edge) {
          plan.edgeFunctions = {
            edgeServer: {
              function: serverConfig,
            },
          };
          plan.behaviors.push(
            {
              cacheType: "server",
              cfFunction: "serverCfFunction",
              edgeFunction: "edgeServer",
              origin: "staticsServer",
            },
            ...fs
              .readdirSync(
                path.join(outputPath, buildMeta.clientBuildOutputDir),
              )
              .map(
                (item) =>
                  ({
                    cacheType: "static",
                    pattern: fs
                      .statSync(
                        path.join(
                          outputPath,
                          buildMeta.clientBuildOutputDir,
                          item,
                        ),
                      )
                      .isDirectory()
                      ? `${item}/*`
                      : item,
                    origin: "staticsServer",
                  }) as const,
              ),
          );
        } else {
          if (isStatic) {
            plan.behaviors.push({
              cacheType: "static",
              cfFunction: "serverCfFunction",
              origin: "staticsServer",
            });
          } else {
            plan.cloudFrontFunctions!.imageServiceCfFunction = {
              injections: [useCloudFrontFunctionHostHeaderInjection()],
            };

            plan.origins.regionalServer = {
              server: {
                function: serverConfig,
                streaming: buildMeta.responseMode === "stream",
              },
            };

            plan.origins.fallthroughServer = {
              group: {
                primaryOriginName: "staticsServer",
                fallbackOriginName: "regionalServer",
                fallbackStatusCodes: [403, 404],
              },
            };

            plan.behaviors.push(
              {
                cacheType: "server",
                cfFunction: "serverCfFunction",
                origin: "fallthroughServer",
                allowedMethods: ["GET", "HEAD", "OPTIONS"],
              },
              {
                cacheType: "static",
                pattern: `${buildMeta.clientBuildVersionedSubDir}/*`,
                origin: "staticsServer",
              },
              {
                cacheType: "server",
                pattern: "_image",
                cfFunction: "imageServiceCfFunction",
                origin: "regionalServer",
                allowedMethods: ["GET", "HEAD", "OPTIONS"],
              },
              ...buildMeta.serverRoutes?.map(
                (route) =>
                  ({
                    cacheType: "server",
                    cfFunction: "serverCfFunctionHostOnly",
                    pattern: route,
                    origin: "regionalServer",
                  }) as const,
              ),
            );
          }

          buildMeta.routes
            .filter(
              ({ type, route }) =>
                type === "page" && /^\/\d{3}\/?$/.test(route),
            )
            .forEach(({ route, prerender }) => {
              switch (route) {
                case "/404":
                case "/404/":
                  plan.errorResponses?.push({
                    errorCode: 404,
                    responsePagePath: prerender ? "/404.html" : "/404",
                    responseCode: 404,
                  });
                  if (isStatic) {
                    plan.errorResponses?.push({
                      errorCode: 403,
                      responsePagePath: "/404.html",
                      responseCode: 404,
                    });
                  }
                  break;
                case "/500":
                case "/500/":
                  plan.errorResponses?.push({
                    errorCode: 500,
                    responsePagePath: prerender ? "/500.html" : "/500",
                    responseCode: 500,
                  });
                  break;
              }
            });
        }

        return validatePlan(plan);
      });
    }
  }

  /**
   * The URL of the Astro site.
   *
   * If the `domain` is set, this is the URL with the custom domain.
   * Otherwise, it's the autogenerated CloudFront URL.
   */
  public get url() {
    return all([this.cdn.domainUrl, this.cdn.url]).apply(
      ([domainUrl, url]) => domainUrl ?? url,
    );
  }

  /**
   * The underlying [resources](/docs/components/#nodes) this component creates.
   */
  public get nodes() {
    return {
      /**
       * The AWS Lambda server function that renders the site.
       */
      server: this.server as unknown as Function,
      /**
       * The Amazon S3 Bucket that stores the assets.
       */
      assets: this.assets,
    };
  }

  /** @internal */
  public getSSTLink() {
    return {
      properties: {
        url: this.url,
      },
    };
  }
}
const __pulumiType = "sst:aws:Astro";
// @ts-expect-error
Astro.__pulumiType = __pulumiType;

type TreeNode = {
  branches: Record<string, TreeNode>;
  nodes: BuildMetaConfig["routes"][number][];
};

type FlattenedRoute =
  | [string] // Page with prerendering
  | [string, 1] // Endpoint with prerendering
  | [string, 2, string | undefined, number | undefined]; // Redirect
type FlattenedRouteTree = Array<FlattenedRoute | [string, FlattenedRouteTree]>;

function useCloudFrontRoutingInjection(buildMetadata: BuildMetaConfig) {
  const tree = buildRouteTree(buildMetadata.routes);
  const flatTree = flattenRouteTree(tree);
  const stringifiedTree = stringifyFlattenedRouteTree(flatTree);
  return `
    var routeData = ${stringifiedTree};
    var findFirstMatch = (matches) => Array.isArray(matches[0]) ? findFirstMatch(matches[0]) : matches;
    var findMatches = (path, routeData) => routeData.map((route) => route[0].test(path) ? Array.isArray(route[1]) ? findMatches(path, route[1]) : route : null).filter(route => route !== null && route.length > 0);
    var matchedRoute = findFirstMatch(findMatches(request.uri, routeData));
    if (matchedRoute[0]) {
      if (!matchedRoute[1] && !/^.*\\.[^\\/]+$/.test(request.uri)) {
        ${
          buildMetadata.pageResolution === "file"
            ? `request.uri = request.uri === "/" ? "/index.html" : request.uri.replace(/\\/?$/, ".html");`
            : `request.uri = request.uri.replace(/\\/?$/, "/index.html");`
        }
      } else if (matchedRoute[1] === 2) {
        var redirectPath = matchedRoute[2];
        matchedRoute[0].exec(request.uri).forEach((match, index) => {
          redirectPath = redirectPath.replace(\`\\\${\${index}}\`, match);
        });
        return {
          statusCode: matchedRoute[3] || 308,
          headers: { location: { value: redirectPath } },
        };
      }
    }`;
}

function buildRouteTree(routes: BuildMetaConfig["routes"], level = 0) {
  const routeTree = routes.reduce<TreeNode>(
    (tree, route) => {
      const routePatternWithoutCaptureGroups = route.pattern
        .replace(/\((?:\?:)?(.*?[^\\])\)/g, (_, content) => content.trim())
        .replace(/\/\^/g, "")
        .replace(/\$\//g, "");
      const routeParts = routePatternWithoutCaptureGroups
        .split(/(?=\\\/)/g)
        .filter((part) => part !== "/^" && part !== "/$/");

      tree.branches[routeParts[level]] = tree.branches[routeParts[level]] || {
        branches: {},
        nodes: [],
      };
      tree.branches[routeParts[level]].nodes.push(route);
      return tree;
    },
    { branches: {}, nodes: [] },
  );

  for (const [key, branch] of Object.entries(routeTree.branches)) {
    if (
      !branch.nodes.some((node) => node.prerender || node.type === "redirect")
    ) {
      delete routeTree.branches[key];
    } else if (branch.nodes.length > 1) {
      const deduplicatedNodes = branch.nodes.filter(
        (node, index, arr) =>
          arr.findIndex((n) => n.pattern === node.pattern) === index,
      );
      routeTree.branches[key] = buildRouteTree(deduplicatedNodes, level + 1);
      branch.nodes = [];
    }
  }

  return routeTree;
}

function flattenRouteTree(tree: TreeNode, parentKey = "") {
  const flatTree: FlattenedRouteTree = [];
  for (const [key, branch] of Object.entries(tree.branches)) {
    if (branch.nodes.length === 1) {
      const node = branch.nodes[0];
      if (node.type === "page") {
        flatTree.push([node.pattern]);
      }
      if (node.type === "endpoint") {
        flatTree.push([node.pattern, 1]);
      } else if (node.type === "redirect") {
        flatTree.push([
          node.pattern,
          2,
          node.redirectPath,
          node.redirectStatus,
        ]);
      }
    } else {
      const flatKey = parentKey + key;
      flatTree.push([flatKey, flattenRouteTree(branch, flatKey)]);
    }
  }
  return flatTree;
}

function stringifyFlattenedRouteTree(tree: FlattenedRouteTree): string {
  return `[${tree
    .map((tuple) => {
      if (Array.isArray(tuple[1])) {
        return `[/^${tuple[0]}/,${stringifyFlattenedRouteTree(tuple[1])}]`;
      }
      if (typeof tuple[1] === "undefined") {
        return `[${tuple[0]}]`;
      } else if (tuple[1] === 1) {
        return `[${tuple[0]},1]`;
      }
      return `[${tuple[0]},2,"${tuple[2]}"${tuple[3] ? `,${tuple[3]}` : ""}]`;
    })
    .join(",")}]`;
}
