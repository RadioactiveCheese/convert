import type { FileData, FileFormat, FormatHandler } from "../FormatHandler.ts";

type DxfGroup = { code: number; value: string };

type Point = { x: number; y: number };

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

class dxfHandler implements FormatHandler {

  public name = "dxf";
  public supportedFormats = [
    {
      name: "AutoCAD Drawing Exchange Format",
      format: "dxf",
      extension: "dxf",
      mime: "image/vnd.dxf",
      from: true,
      to: false,
      internal: "dxf"
    },
    {
      name: "Scalable Vector Graphics",
      format: "svg",
      extension: "svg",
      mime: "image/svg+xml",
      from: false,
      to: true,
      internal: "svg"
    }
  ];

  public ready = false;

  async init() {
    // This handler uses an internal DXF parser and SVG renderer.
    this.ready = true;
  }

  async doConvert(
    inputFiles: FileData[],
    inputFormat: FileFormat,
    outputFormat: FileFormat
  ): Promise<FileData[]> {
    if (!this.ready) throw "Handler not initialized.";
    if (inputFormat.internal !== "dxf" || outputFormat.internal !== "svg") {
      throw "Invalid output format.";
    }

    const outputFiles: FileData[] = [];

    for (const inputFile of inputFiles) {
      const dxfText = new TextDecoder().decode(inputFile.bytes);
      const { svg, bounds } = this.convertDxfToSvg(dxfText);

      if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) {
        throw "Unable to determine DXF drawing bounds.";
      }

      const outputName = inputFile.name.replace(/\.[^/.]+$/, "") + "." + outputFormat.extension;
      outputFiles.push({
        name: outputName,
        bytes: new Uint8Array(new TextEncoder().encode(svg))
      });
    }

    return outputFiles;
  }

  private convertDxfToSvg(dxfText: string): { svg: string; bounds: Bounds } {
    const groups = this.parseGroups(dxfText);
    const entities = this.extractEntityGroups(groups);
    const svgParts: string[] = [];

    const boundsFromHeader = this.extractHeaderBounds(groups);
    const bounds = boundsFromHeader ?? this.createEmptyBounds();

    for (let entityIndex = 0; entityIndex < entities.length; entityIndex++) {
      const entity = entities[entityIndex];
      const type = this.getGroupValue(entity, 0)?.toUpperCase();
      if (!type) continue;

      switch (type) {
        case "LINE": {
          const x1 = this.getGroupNumber(entity, 10);
          const y1 = this.getGroupNumber(entity, 20);
          const x2 = this.getGroupNumber(entity, 11);
          const y2 = this.getGroupNumber(entity, 21);
          if ([x1, y1, x2, y2].some(v => v === undefined)) break;

          this.includePoint(bounds, { x: x1!, y: y1! });
          this.includePoint(bounds, { x: x2!, y: y2! });
          svgParts.push(`<line x1="${x1}" y1="${-y1!}" x2="${x2}" y2="${-y2!}" />`);
          break;
        }
        case "POINT": {
          const x = this.getGroupNumber(entity, 10);
          const y = this.getGroupNumber(entity, 20);
          if (x === undefined || y === undefined) break;
          this.includePoint(bounds, { x, y });
          svgParts.push(`<circle cx="${x}" cy="${-y}" r="1" />`);
          break;
        }
        case "CIRCLE": {
          const cx = this.getGroupNumber(entity, 10);
          const cy = this.getGroupNumber(entity, 20);
          const r = this.getGroupNumber(entity, 40);
          if ([cx, cy, r].some(v => v === undefined)) break;

          this.includePoint(bounds, { x: cx! - r!, y: cy! - r! });
          this.includePoint(bounds, { x: cx! + r!, y: cy! + r! });
          svgParts.push(`<circle cx="${cx}" cy="${-cy!}" r="${r}" fill="none" />`);
          break;
        }
        case "ARC": {
          const cx = this.getGroupNumber(entity, 10);
          const cy = this.getGroupNumber(entity, 20);
          const r = this.getGroupNumber(entity, 40);
          const startDeg = this.getGroupNumber(entity, 50);
          const endDeg = this.getGroupNumber(entity, 51);
          if ([cx, cy, r, startDeg, endDeg].some(v => v === undefined)) break;

          const { path, points } = this.buildArcPath(cx!, cy!, r!, startDeg!, endDeg!);
          for (const point of points) this.includePoint(bounds, point);
          svgParts.push(`<path d="${path}" fill="none" />`);
          break;
        }
        case "LWPOLYLINE": {
          const vertices = this.extractLwPolylineVertices(entity);
          if (vertices.length < 2) break;
          const isClosed = (this.getGroupNumber(entity, 70) ?? 0) & 1;
          for (const point of vertices) this.includePoint(bounds, point);

          const points = vertices.map(v => `${v.x},${-v.y}`).join(" ");
          if (isClosed) {
            svgParts.push(`<polygon points="${points}" fill="none" />`);
          } else {
            svgParts.push(`<polyline points="${points}" fill="none" />`);
          }
          break;
        }
        case "POLYLINE": {
          const vertices: Point[] = [];
          const isClosed = (this.getGroupNumber(entity, 70) ?? 0) & 1;
          for (let j = entityIndex + 1; j < entities.length; j++) {
            const vertexEntity = entities[j];
            const vertexType = this.getGroupValue(vertexEntity, 0)?.toUpperCase();
            if (vertexType === "SEQEND") {
              entityIndex = j;
              break;
            }
            if (vertexType !== "VERTEX") continue;
            const x = this.getGroupNumber(vertexEntity, 10);
            const y = this.getGroupNumber(vertexEntity, 20);
            if (x === undefined || y === undefined) continue;
            vertices.push({ x, y });
          }

          if (vertices.length < 2) break;
          for (const point of vertices) this.includePoint(bounds, point);

          const points = vertices.map(v => `${v.x},${-v.y}`).join(" ");
          if (isClosed) {
            svgParts.push(`<polygon points="${points}" fill="none" />`);
          } else {
            svgParts.push(`<polyline points="${points}" fill="none" />`);
          }
          break;
        }
        case "VERTEX":
        case "SEQEND": {
          break;
        }
        default:
          break;
      }
    }

    if (!this.hasBounds(bounds)) {
      this.includePoint(bounds, { x: 0, y: 0 });
      this.includePoint(bounds, { x: 1, y: 1 });
    }

    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const viewMinX = bounds.minX;
    const viewMinY = -bounds.maxY;

    const svg = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewMinX} ${viewMinY} ${width} ${height}" stroke="black" fill="none" stroke-width="1">`,
      ...svgParts,
      `</svg>`
    ].join("\n");

    return { svg, bounds };
  }

  private parseGroups(dxfText: string): DxfGroup[] {
    const lines = dxfText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const groups: DxfGroup[] = [];

    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = Number.parseInt(lines[i].trim(), 10);
      if (Number.isNaN(code)) continue;
      groups.push({ code, value: lines[i + 1] });
    }

    return groups;
  }

  private extractEntityGroups(groups: DxfGroup[]): DxfGroup[][] {
    const entities: DxfGroup[][] = [];
    let inEntitiesSection = false;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.code === 0 && group.value === "SECTION" && groups[i + 1]?.code === 2 && groups[i + 1]?.value === "ENTITIES") {
        inEntitiesSection = true;
        i += 1;
        continue;
      }
      if (!inEntitiesSection) continue;
      if (group.code === 0 && group.value === "ENDSEC") break;

      if (group.code === 0) {
        const entity: DxfGroup[] = [group];
        let j = i + 1;
        for (; j < groups.length; j++) {
          if (groups[j].code === 0) break;
          entity.push(groups[j]);
        }
        entities.push(entity);
        i = j - 1;
      }
    }

    return entities;
  }

  private extractHeaderBounds(groups: DxfGroup[]): Bounds | undefined {
    let inHeaderSection = false;
    let minX: number | undefined;
    let minY: number | undefined;
    let maxX: number | undefined;
    let maxY: number | undefined;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.code === 0 && group.value === "SECTION" && groups[i + 1]?.code === 2 && groups[i + 1]?.value === "HEADER") {
        inHeaderSection = true;
        i += 1;
        continue;
      }
      if (!inHeaderSection) continue;
      if (group.code === 0 && group.value === "ENDSEC") break;

      if (group.code === 9 && group.value === "$EXTMIN") {
        minX = this.findNextNumericValue(groups, i + 1, 10);
        minY = this.findNextNumericValue(groups, i + 1, 20);
      }
      if (group.code === 9 && group.value === "$EXTMAX") {
        maxX = this.findNextNumericValue(groups, i + 1, 10);
        maxY = this.findNextNumericValue(groups, i + 1, 20);
      }
    }

    if ([minX, minY, maxX, maxY].some(v => v === undefined)) return undefined;

    return {
      minX: minX!,
      minY: minY!,
      maxX: maxX!,
      maxY: maxY!
    };
  }

  private findNextNumericValue(groups: DxfGroup[], startIndex: number, code: number): number | undefined {
    for (let i = startIndex; i < groups.length; i++) {
      const group = groups[i];
      if (group.code === 9 || group.code === 0) return undefined;
      if (group.code === code) {
        const parsed = Number.parseFloat(group.value);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
    }
    return undefined;
  }

  private extractLwPolylineVertices(entity: DxfGroup[]): Point[] {
    const vertices: Point[] = [];
    let pendingX: number | undefined;

    for (const group of entity) {
      if (group.code === 10) {
        const parsedX = Number.parseFloat(group.value);
        pendingX = Number.isFinite(parsedX) ? parsedX : undefined;
      } else if (group.code === 20 && pendingX !== undefined) {
        const parsedY = Number.parseFloat(group.value);
        if (Number.isFinite(parsedY)) {
          vertices.push({ x: pendingX, y: parsedY });
        }
        pendingX = undefined;
      }
    }

    return vertices;
  }

  private buildArcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): { path: string; points: Point[] } {
    const startRad = (startDeg * Math.PI) / 180;
    let endRad = (endDeg * Math.PI) / 180;

    while (endRad < startRad) {
      endRad += Math.PI * 2;
    }

    const startPoint: Point = {
      x: cx + r * Math.cos(startRad),
      y: cy + r * Math.sin(startRad)
    };
    const endPoint: Point = {
      x: cx + r * Math.cos(endRad),
      y: cy + r * Math.sin(endRad)
    };
    const largeArcFlag = endRad - startRad > Math.PI ? 1 : 0;

    const path = [
      `M ${startPoint.x} ${-startPoint.y}`,
      `A ${r} ${r} 0 ${largeArcFlag} 0 ${endPoint.x} ${-endPoint.y}`
    ].join(" ");

    return {
      path,
      points: [
        { x: cx - r, y: cy - r },
        { x: cx + r, y: cy + r },
        startPoint,
        endPoint
      ]
    };
  }

  private getGroupValue(groups: DxfGroup[], code: number): string | undefined {
    return groups.find(g => g.code === code)?.value;
  }

  private getGroupNumber(groups: DxfGroup[], code: number): number | undefined {
    const raw = this.getGroupValue(groups, code);
    if (raw === undefined) return undefined;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private createEmptyBounds(): Bounds {
    return {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    };
  }

  private includePoint(bounds: Bounds, point: Point) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }

  private hasBounds(bounds: Bounds): boolean {
    return Number.isFinite(bounds.minX)
      && Number.isFinite(bounds.minY)
      && Number.isFinite(bounds.maxX)
      && Number.isFinite(bounds.maxY);
  }

}

export default dxfHandler;
