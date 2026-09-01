export const OPERATIONS = [
  {
    "method": "POST",
    "path": "/api/v1/identify",
    "operationId": "identifyUser",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/track",
    "operationId": "trackEvent",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/messages",
    "operationId": "getMessages",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/deliveries/{id}/event",
    "operationId": "recordDeliveryEvent",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaign-media",
    "operationId": "uploadCampaignMedia",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns",
    "operationId": "listCampaigns",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns",
    "operationId": "createCampaign",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}",
    "operationId": "getCampaign",
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/campaigns/{id}",
    "operationId": "updateCampaign",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/campaigns/{id}/status",
    "operationId": "setCampaignStatus",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/deliveries",
    "operationId": "listCampaignDeliveries",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/campaigns/{id}/conversions",
    "operationId": "getCampaignEventConversions",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users",
    "operationId": "listUsers",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/summary",
    "operationId": "getUserSummary",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}",
    "operationId": "getUser",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}/events",
    "operationId": "listUserEvents",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/users/{id}/deliveries",
    "operationId": "listUserDeliveries",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/events",
    "operationId": "listEvents",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/goals",
    "operationId": "listGoals",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/goals",
    "operationId": "createGoal",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/goals/{id}",
    "operationId": "getGoal",
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/goals/{id}",
    "operationId": "updateGoal",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent-runs",
    "operationId": "listAgentRuns",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent-runs",
    "operationId": "createAgentRun",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/audiences/capabilities",
    "operationId": "getAudienceCapabilities",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/audiences/check",
    "operationId": "checkAudience",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/audiences/explain",
    "operationId": "explainAudience",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments",
    "operationId": "listSegments",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/segments",
    "operationId": "createSegment",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}",
    "operationId": "getSegment",
    "availability": "product"
  },
  {
    "method": "PATCH",
    "path": "/api/v1/segments/{id}",
    "operationId": "updateSegment",
    "availability": "product"
  },
  {
    "method": "POST",
    "path": "/api/v1/segments/{id}/archive",
    "operationId": "archiveSegment",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}/versions",
    "operationId": "listSegmentVersions",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/segments/{id}/versions/{version}",
    "operationId": "getSegmentVersion",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent/settings",
    "operationId": "getAgentSettings",
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent/usage-reports",
    "operationId": "reportAgentUsage",
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/evaluations/due",
    "operationId": "listDueEvaluations",
    "availability": "galinum_cloud"
  },
  {
    "method": "PUT",
    "path": "/api/v1/evaluations/{campaignId}",
    "operationId": "scheduleCampaignEvaluation",
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/claim",
    "operationId": "claimCampaignEvaluation",
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/complete",
    "operationId": "completeCampaignEvaluation",
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/evaluations/{campaignId}/mutate",
    "operationId": "mutateClaimedCampaign",
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/agent/proposals",
    "operationId": "listAgentProposals",
    "availability": "galinum_cloud"
  },
  {
    "method": "POST",
    "path": "/api/v1/agent/proposals",
    "operationId": "createAgentProposal",
    "availability": "galinum_cloud"
  },
  {
    "method": "GET",
    "path": "/api/v1/usage",
    "operationId": "getUsage",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/overview",
    "operationId": "getProjectOverview",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/activity",
    "operationId": "listProjectActivity",
    "availability": "product"
  },
  {
    "method": "GET",
    "path": "/api/v1/metrics",
    "operationId": "getProjectMetrics",
    "availability": "product"
  }
] as const;

export type OperationId = (typeof OPERATIONS)[number]["operationId"];
