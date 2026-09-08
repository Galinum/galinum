import type { ShippingWarning } from "@galinum/core";
import type { ActivationMapping, ActivationSettings, ActivationState, ProductActivationData, StockPreparation, StockProjectControls, StockSource } from "./store.js";

export class MemoryActivationData implements ProductActivationData {
  private settingsValue: ActivationSettings | null = null;
  private controlsValue: StockProjectControls = { paused: false, version: 0 };
  private mappingValues = new Map<string, ActivationMapping>();
  private stateValues = new Map<string, ActivationState>();
  private warningValues = new Map<string, { campaignId: string; value: ShippingWarning }>();
  private sourceValues = new Map<string, StockSource>();
  private preparationValues = new Map<string, StockPreparation>();

  clone(): MemoryActivationData {
    const copy = new MemoryActivationData();
    copy.settingsValue = this.settingsValue;
    copy.controlsValue = this.controlsValue;
    copy.mappingValues = new Map(this.mappingValues);
    copy.stateValues = new Map(this.stateValues);
    copy.warningValues = new Map(this.warningValues);
    copy.sourceValues = new Map(this.sourceValues);
    copy.preparationValues = new Map(this.preparationValues);
    return copy;
  }

  async settings(): Promise<ActivationSettings | null> { return structuredClone(this.settingsValue); }
  async saveSettings(value: ActivationSettings): Promise<void> { this.settingsValue = structuredClone(value); }
  async controls(): Promise<StockProjectControls> { return structuredClone(this.controlsValue); }
  async saveControls(value: StockProjectControls): Promise<void> { this.controlsValue = structuredClone(value); }

  async mappings(): Promise<ActivationMapping[]> {
    return structuredClone([...this.mappingValues.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async saveMapping(value: ActivationMapping): Promise<void> {
    if ([...this.mappingValues.values()].some(mapping => mapping.id !== value.id && mapping.repositoryId === value.repositoryId && mapping.environment === value.environment)) {
      throw new Error("Deployment mapping already exists");
    }
    this.mappingValues.set(value.id, structuredClone({ ...value, sourceIds: [...new Set(value.sourceIds)].sort() }));
  }

  async deleteMapping(id: string): Promise<void> { this.mappingValues.delete(id); }
  async state(campaignId: string): Promise<ActivationState | null> { return structuredClone(this.stateValues.get(campaignId) ?? null); }
  async saveState(campaignId: string, value: ActivationState): Promise<void> { this.stateValues.set(campaignId, structuredClone(value)); }

  async warnings(campaignId: string): Promise<ShippingWarning[]> {
    return structuredClone([...this.warningValues.values()].filter(row => row.campaignId === campaignId).map(row => row.value)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  }

  async insertWarning(campaignId: string, value: ShippingWarning): Promise<void> {
    const existing = this.warningValues.get(value.id);
    if (existing) {
      if (existing.campaignId !== campaignId) throw new Error("Warning identity belongs to another campaign");
      return;
    }
    this.warningValues.set(value.id, { campaignId, value: structuredClone(value) });
  }

  async sources(): Promise<StockSource[]> {
    return structuredClone([...this.sourceValues.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async saveSource(value: StockSource): Promise<void> {
    if ([...this.sourceValues.values()].some(source => source.id !== value.id && source.installationId === value.installationId
      && source.repositoryId === value.repositoryId && source.branch === value.branch)) throw new Error("Source binding already exists");
    this.sourceValues.set(value.id, structuredClone(value));
  }

  async preparation(campaignId: string): Promise<StockPreparation | null> { return structuredClone(this.preparationValues.get(campaignId) ?? null); }
  async savePreparation(campaignId: string, value: StockPreparation): Promise<void> { this.preparationValues.set(campaignId, structuredClone(value)); }
  async preparationCampaignIds(after: string, limit: number): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid preparation page limit");
    return [...this.preparationValues.keys()].filter(id => id > after).sort().slice(0, limit);
  }
}
