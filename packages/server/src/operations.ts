export const SECURITY_SCHEMES = {
  "publishableKey": {
    "type": "http",
    "scheme": "bearer",
    "description": "Your project's publishable key (`pk_pub_…`). Safe to expose in the browser — it identifies the project and is rate-limited, not secret."
  },
  "secretKey": {
    "type": "http",
    "scheme": "bearer",
    "description": "Your project's secret key (`pk_…`, without the `pub` segment). Server-side only — never ship it to a browser. Get it from Settings → Projects in the dashboard."
  },
  "hostedAgentKey": {
    "type": "http",
    "scheme": "bearer",
    "description": "Galinum's scoped hosted-agent key (pk_agent_...). It can read required project state, including launch policy and campaign activation, and use fenced evaluation or GitHub source operations. Ordinary campaign, status, goal, segment, media, launch-policy, and campaign-activation writes return 403. Reads grant no approval or deployment configuration authority."
  },
  "installationCapability": {
    "type": "apiKey",
    "in": "header",
    "name": "X-Galinum-Installation-Capability",
    "description": "Locally generated installation capability. Required with the project publishable key for installation reads and mutations."
  }
} as const;
export type SecurityScheme = keyof typeof SECURITY_SCHEMES;

export const OPERATIONS = [
  {
    "method": "POST",
    "path": "/api/v1/identify",
    "operationId": "identifyUser",
    "security": [
      {
        "publishableKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/track",
    "operationId": "trackEvent",
    "security": [
      {
        "publishableKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/messages",
    "operationId": "getMessages",
    "security": [
      {
        "publishableKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/deliveries/{id}/event",
    "operationId": "recordDeliveryEvent",
    "security": [
      {
        "publishableKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaign-media",
    "operationId": "uploadCampaignMedia",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns",
    "operationId": "listCampaigns",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns",
    "operationId": "createCampaign",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}",
    "operationId": "getCampaign",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/campaigns/{id}",
    "operationId": "updateCampaign",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns/{id}/status",
    "operationId": "setCampaignStatus",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/deliveries",
    "operationId": "listCampaignDeliveries",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/conversions",
    "operationId": "getCampaignEventConversions",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users",
    "operationId": "listUsers",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/summary",
    "operationId": "getUserSummary",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}",
    "operationId": "getUser",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}/events",
    "operationId": "listUserEvents",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}/deliveries",
    "operationId": "listUserDeliveries",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/events",
    "operationId": "listEvents",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/goals",
    "operationId": "listGoals",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/goals",
    "operationId": "createGoal",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/goals/{id}",
    "operationId": "getGoal",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/goals/{id}",
    "operationId": "updateGoal",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent-runs",
    "operationId": "listAgentRuns",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent-runs",
    "operationId": "createAgentRun",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/audiences/capabilities",
    "operationId": "getAudienceCapabilities",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/audiences/check",
    "operationId": "checkAudience",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/audiences/explain",
    "operationId": "explainAudience",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments",
    "operationId": "listSegments",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/segments",
    "operationId": "createSegment",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}",
    "operationId": "getSegment",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/segments/{id}",
    "operationId": "updateSegment",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/segments/{id}/archive",
    "operationId": "archiveSegment",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}/versions",
    "operationId": "listSegmentVersions",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}/versions/{version}",
    "operationId": "getSegmentVersion",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent/settings",
    "operationId": "getAgentSettings",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent/usage-reports",
    "operationId": "reportAgentUsage",
    "security": [
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/evaluations/due",
    "operationId": "listDueEvaluations",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "PUT",
    "path": "/api/v1/evaluations/{campaignId}",
    "operationId": "scheduleCampaignEvaluation",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/claim",
    "operationId": "claimCampaignEvaluation",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/complete",
    "operationId": "completeCampaignEvaluation",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/mutate",
    "operationId": "mutateClaimedCampaign",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent/proposals",
    "operationId": "listAgentProposals",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent/proposals",
    "operationId": "createAgentProposal",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/usage",
    "operationId": "getUsage",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/overview",
    "operationId": "getProjectOverview",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/activity",
    "operationId": "listProjectActivity",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/metrics",
    "operationId": "getProjectMetrics",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/github/refs/due",
    "operationId": "listDueGithubRefs",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/github/refs/{refId}/claim",
    "operationId": "claimGithubRef",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/github/refs/{refId}/reconcile",
    "operationId": "reconcileGithubRef",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/sdk/installations",
    "operationId": "bootstrapInstallation",
    "security": [
      {
        "publishableKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/sdk/installations/{installationId}",
    "operationId": "getInstallation",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PUT",
    "path": "/api/v1/sdk/installations/{installationId}/binding",
    "operationId": "setInstallationBinding",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PUT",
    "path": "/api/v1/sdk/installations/{installationId}/facts",
    "operationId": "setInstallationFacts",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PUT",
    "path": "/api/v1/sdk/installations/{installationId}/token",
    "operationId": "setInstallationToken",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/sdk/installations/{installationId}/activity",
    "operationId": "recordInstallationActivity",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/installations",
    "operationId": "listInstallations",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/push/credentials",
    "operationId": "listPushCredentials",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PUT",
    "path": "/api/v1/push/credentials",
    "operationId": "configurePushCredential",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/push/credentials/validate",
    "operationId": "validatePushCredential",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns/{id}/push/dispatch",
    "operationId": "dispatchPushCampaign",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns/{id}/push/test",
    "operationId": "testPushCampaign",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/push",
    "operationId": "inspectPushCampaign",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/sdk/installations/{installationId}/observations",
    "operationId": "observeInstallationPush",
    "security": [
      {
        "publishableKey": [],
        "installationCapability": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/push/tests/{requestId}",
    "operationId": "getPushTest",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/launch-policy",
    "operationId": "getLaunchPolicy",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/launch-policy",
    "operationId": "setLaunchPolicy",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/activation",
    "operationId": "getCampaignActivation",
    "security": [
      {
        "secretKey": []
      },
      {
        "hostedAgentKey": []
      }
    ],
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/campaigns/{id}/activation",
    "operationId": "setCampaignActivationMode",
    "security": [
      {
        "secretKey": []
      }
    ],
    "availability": "product"
  }
] as const;

export type OperationId = (typeof OPERATIONS)[number]["operationId"];
