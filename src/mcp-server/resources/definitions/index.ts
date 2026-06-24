/**
 * @fileoverview Resource definitions barrel — assembles allResourceDefinitions for createApp().
 * @module mcp-server/resources/definitions/index
 */

import { occurrenceResource } from './occurrence.resource.js';
import { taxonResource } from './taxon.resource.js';

export const allResourceDefinitions = [occurrenceResource, taxonResource];
