import { Controller, Delete, Get, HttpCode, Patch, Post, Put } from '@nestjs/common';
import {
  AvailabilityListQuerySchema,
  CreateMenuAssignmentSchema,
  CreateMenuSchema,
  CreateMenuSectionSchema,
  CreateModifierGroupSchema,
  CreateModifierSchema,
  ItemAvailabilityPageSchema,
  ItemAvailabilitySchema,
  ItemModifierGroupLinkSchema,
  LinkModifierGroupSchema,
  MenuAssignmentSchema,
  MenuListQuerySchema,
  MenuPageSchema,
  MenuResolutionSchema,
  MenuResolveQuerySchema,
  MenuSchema,
  MenuSectionItemSchema,
  MenuSectionSchema,
  MenuTreeSchema,
  ModifierGroupDetailSchema,
  ModifierGroupListQuerySchema,
  ModifierGroupPageSchema,
  ModifierSchema,
  ModifierValidationSchema,
  PutItemAvailabilitySchema,
  PutMenuSectionItemSchema,
  UpdateMenuAssignmentSchema,
  UpdateMenuSchema,
  UpdateMenuSectionSchema,
  UpdateModifierGroupSchema,
  UpdateModifierSchema,
  ValidateModifierSelectionSchema,
} from '@pos/contracts';
import { z } from 'zod';

import { Contract, IfMatch, ValidBody, ValidParams, ValidQuery } from '../kernel/public/index.js';
import { AvailabilityService } from './availability/availability.service.js';
import { TAGS, TENANT, fixtureParam, idParam, uuid } from './catalog.http.js';
import { MenusService } from './menus/menus.service.js';
import { ModifiersService } from './modifiers/modifiers.service.js';

@Controller('modifier-groups')
export class ModifierGroupsController {
  constructor(private readonly modifiers: ModifiersService) {}

  @Get()
  @Contract({
    operationId: 'catalog.modifier_group.list',
    tags: TAGS,
    query: ModifierGroupListQuerySchema,
    response: ModifierGroupPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof ModifierGroupListQuerySchema>) {
    return this.modifiers.listGroups(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.modifier_group.create',
    tags: TAGS,
    body: CreateModifierGroupSchema,
    response: ModifierGroupDetailSchema,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      body: {
        name: 'Size',
        prompt: 'Choose your size',
        selectionMin: 1,
        selectionMax: 1,
        modifiers: [{ name: 'Regular' }, { name: 'Large', priceDeltaMinor: '150' }],
      },
    },
  })
  create(@ValidBody() body: z.infer<typeof CreateModifierGroupSchema>) {
    return this.modifiers.createGroup(body);
  }

  @Get(':groupId')
  @Contract({
    operationId: 'catalog.modifier_group.get',
    tags: TAGS,
    params: idParam('groupId'),
    response: ModifierGroupDetailSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('groupId'),
  })
  get(@ValidParams() params: { groupId: string }) {
    return this.modifiers.getGroup(params.groupId);
  }

  @Patch(':groupId')
  @Contract({
    operationId: 'catalog.modifier_group.update',
    tags: TAGS,
    params: idParam('groupId'),
    body: UpdateModifierGroupSchema,
    response: ModifierGroupDetailSchema,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('groupId'), body: { prompt: 'Pick one' } },
  })
  update(
    @ValidParams() params: { groupId: string },
    @ValidBody() body: z.infer<typeof UpdateModifierGroupSchema>,
    @IfMatch() version: number,
  ) {
    return this.modifiers.updateGroup(params.groupId, body, version);
  }

  @Post(':groupId/modifiers')
  @Contract({
    operationId: 'catalog.modifier.create',
    tags: TAGS,
    params: idParam('groupId'),
    body: CreateModifierSchema,
    response: ModifierSchema,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    idempotent: true,
    examples: { ...fixtureParam('groupId'), body: { name: 'Extra shot', priceDeltaMinor: '80' } },
  })
  createModifier(
    @ValidParams() params: { groupId: string },
    @ValidBody() body: z.infer<typeof CreateModifierSchema>,
  ) {
    return this.modifiers.createModifier(params.groupId, body);
  }
}

@Controller()
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  @Patch('modifiers/:modifierId')
  @Contract({
    operationId: 'catalog.modifier.update',
    tags: TAGS,
    params: idParam('modifierId'),
    body: UpdateModifierSchema,
    response: ModifierSchema,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    examples: { ...fixtureParam('modifierId'), body: { kitchenLabel: 'XTRA' } },
  })
  update(
    @ValidParams() params: { modifierId: string },
    @ValidBody() body: z.infer<typeof UpdateModifierSchema>,
  ) {
    return this.modifiers.updateModifier(params.modifierId, body);
  }

  @Delete('modifiers/:modifierId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.modifier.delete',
    tags: TAGS,
    params: idParam('modifierId'),
    status: 204,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    examples: fixtureParam('modifierId'),
  })
  async delete(@ValidParams() params: { modifierId: string }): Promise<void> {
    await this.modifiers.deleteModifier(params.modifierId);
  }

  @Get('items/:itemId/modifier-groups')
  @Contract({
    operationId: 'catalog.item_modifier_group.list',
    summary: 'Modifier groups linked to an item, with their modifiers',
    tags: TAGS,
    params: idParam('itemId'),
    response: z.array(ModifierGroupDetailSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('itemId'),
  })
  listLinks(@ValidParams() params: { itemId: string }) {
    return this.modifiers.listLinks(params.itemId);
  }

  @Put('items/:itemId/modifier-groups/:groupId')
  @Contract({
    operationId: 'catalog.item_modifier_group.put',
    summary: 'Link (or update the link of) a modifier group to an item',
    tags: TAGS,
    params: z.object({ itemId: uuid, groupId: uuid }),
    body: LinkModifierGroupSchema,
    response: ItemModifierGroupLinkSchema,
    status: 200,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    examples: {
      params: { itemId: 'itemId', groupId: 'groupId' },
      body: { displayOrder: 1, overrides: { selectionMin: 0 } },
    },
  })
  link(
    @ValidParams() params: { itemId: string; groupId: string },
    @ValidBody() body: z.infer<typeof LinkModifierGroupSchema>,
  ) {
    return this.modifiers.link(params.itemId, params.groupId, body);
  }

  @Delete('items/:itemId/modifier-groups/:groupId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.item_modifier_group.delete',
    tags: TAGS,
    params: z.object({ itemId: uuid, groupId: uuid }),
    status: 204,
    permission: 'catalog.modifier.manage',
    scope: TENANT,
    examples: { params: { itemId: 'itemId', groupId: 'groupId' } },
  })
  async unlink(@ValidParams() params: { itemId: string; groupId: string }): Promise<void> {
    await this.modifiers.unlink(params.itemId, params.groupId);
  }

  @Post('items/:itemId/modifier-selection/validate')
  @HttpCode(200)
  @Contract({
    operationId: 'catalog.modifier_selection.validate',
    summary:
      'Validate picks against selection_min/max, allow_repeat, status and per-modifier limits',
    tags: TAGS,
    params: idParam('itemId'),
    body: ValidateModifierSelectionSchema,
    response: ModifierValidationSchema,
    status: 200,
    permission: 'catalog.view',
    scope: TENANT,
    idempotent: true,
    examples: {
      ...fixtureParam('itemId'),
      body: {
        selections: [
          { groupId: '$fixture:groupId', modifierId: '$fixture:modifierId', quantity: 1 },
        ],
      },
    },
  })
  validate(
    @ValidParams() params: { itemId: string },
    @ValidBody() body: z.infer<typeof ValidateModifierSelectionSchema>,
  ) {
    return this.modifiers.validate(params.itemId, body);
  }
}

@Controller('menus')
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  /** Declared before `:menuId` so "resolve" is never read as an id. */
  @Get('resolve')
  @Contract({
    operationId: 'catalog.menu.resolve',
    summary: 'The menu for (location, channel, local time): highest-priority eligible assignment',
    tags: TAGS,
    query: MenuResolveQuerySchema,
    response: MenuResolutionSchema,
    permission: 'catalog.view',
    scope: { kind: 'dynamic', from: 'query', scopeKind: 'location', idField: 'locationId' },
    examples: { query: { locationId: '$fixture:locationId', channel: 'dine_in' } },
  })
  resolve(@ValidQuery() query: z.infer<typeof MenuResolveQuerySchema>) {
    return this.menus.resolve(query);
  }

  @Get()
  @Contract({
    operationId: 'catalog.menu.list',
    tags: TAGS,
    query: MenuListQuerySchema,
    response: MenuPageSchema,
    permission: 'catalog.view',
    scope: TENANT,
  })
  list(@ValidQuery() query: z.infer<typeof MenuListQuerySchema>) {
    return this.menus.list(query);
  }

  @Post()
  @Contract({
    operationId: 'catalog.menu.create',
    tags: TAGS,
    body: CreateMenuSchema,
    response: MenuSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    idempotent: true,
    examples: { body: { name: 'Lunch menu' } },
  })
  create(@ValidBody() body: z.infer<typeof CreateMenuSchema>) {
    return this.menus.create(body);
  }

  @Get(':menuId')
  @Contract({
    operationId: 'catalog.menu.get',
    summary: 'A menu with its sections and section items',
    tags: TAGS,
    params: idParam('menuId'),
    response: MenuTreeSchema,
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('menuId'),
  })
  get(@ValidParams() params: { menuId: string }) {
    return this.menus.get(params.menuId);
  }

  @Patch(':menuId')
  @Contract({
    operationId: 'catalog.menu.update',
    tags: TAGS,
    params: idParam('menuId'),
    body: UpdateMenuSchema,
    response: MenuSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    concurrency: 'if-match',
    examples: { ...fixtureParam('menuId'), body: { description: 'Weekday lunch' } },
  })
  update(
    @ValidParams() params: { menuId: string },
    @ValidBody() body: z.infer<typeof UpdateMenuSchema>,
    @IfMatch() version: number,
  ) {
    return this.menus.update(params.menuId, body, version);
  }

  @Post(':menuId/publish')
  @HttpCode(200)
  @Contract({
    operationId: 'catalog.menu.publish',
    summary: 'Publish: bumps the menu version and emits menu.published',
    tags: TAGS,
    params: idParam('menuId'),
    response: MenuSchema,
    status: 200,
    permission: 'catalog.menu.publish',
    scope: TENANT,
    idempotent: true,
    concurrency: 'if-match',
    examples: fixtureParam('menuId'),
  })
  publish(@ValidParams() params: { menuId: string }, @IfMatch() version: number) {
    return this.menus.publish(params.menuId, version);
  }

  @Post(':menuId/sections')
  @Contract({
    operationId: 'catalog.menu_section.create',
    tags: TAGS,
    params: idParam('menuId'),
    body: CreateMenuSectionSchema,
    response: MenuSectionSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    idempotent: true,
    examples: { ...fixtureParam('menuId'), body: { name: 'Mains', layout: { columns: 3 } } },
  })
  createSection(
    @ValidParams() params: { menuId: string },
    @ValidBody() body: z.infer<typeof CreateMenuSectionSchema>,
  ) {
    return this.menus.createSection(params.menuId, body);
  }

  @Get(':menuId/assignments')
  @Contract({
    operationId: 'catalog.menu_assignment.list',
    tags: TAGS,
    params: idParam('menuId'),
    response: z.array(MenuAssignmentSchema),
    permission: 'catalog.view',
    scope: TENANT,
    examples: fixtureParam('menuId'),
  })
  listAssignments(@ValidParams() params: { menuId: string }) {
    return this.menus.listAssignments(params.menuId);
  }

  @Post(':menuId/assignments')
  @Contract({
    operationId: 'catalog.menu_assignment.create',
    summary: 'Assign a menu to a scope/channel/schedule; needs catalog.menu.manage at that scope',
    tags: TAGS,
    params: idParam('menuId'),
    body: CreateMenuAssignmentSchema,
    response: MenuAssignmentSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    idempotent: true,
    examples: {
      ...fixtureParam('menuId'),
      body: {
        scopeKind: 'location',
        scopeId: '$fixture:locationId',
        channel: 'dine_in',
        schedule: { days: [1, 2, 3, 4, 5], windows: [{ from: '11:00', to: '15:00' }] },
        priority: 200,
      },
    },
  })
  createAssignment(
    @ValidParams() params: { menuId: string },
    @ValidBody() body: z.infer<typeof CreateMenuAssignmentSchema>,
  ) {
    return this.menus.createAssignment(params.menuId, body);
  }
}

@Controller()
export class MenuDetailsController {
  constructor(private readonly menus: MenusService) {}

  @Patch('menu-sections/:sectionId')
  @Contract({
    operationId: 'catalog.menu_section.update',
    tags: TAGS,
    params: idParam('sectionId'),
    body: UpdateMenuSectionSchema,
    response: MenuSectionSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: { ...fixtureParam('sectionId'), body: { displayOrder: 2 } },
  })
  updateSection(
    @ValidParams() params: { sectionId: string },
    @ValidBody() body: z.infer<typeof UpdateMenuSectionSchema>,
  ) {
    return this.menus.updateSection(params.sectionId, body);
  }

  @Delete('menu-sections/:sectionId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.menu_section.delete',
    tags: TAGS,
    params: idParam('sectionId'),
    status: 204,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: fixtureParam('sectionId'),
  })
  async deleteSection(@ValidParams() params: { sectionId: string }): Promise<void> {
    await this.menus.deleteSection(params.sectionId);
  }

  @Put('menu-sections/:sectionId/items/:itemId')
  @Contract({
    operationId: 'catalog.menu_section_item.put',
    tags: TAGS,
    params: z.object({ sectionId: uuid, itemId: uuid }),
    body: PutMenuSectionItemSchema,
    response: MenuSectionItemSchema,
    status: 200,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: {
      params: { sectionId: 'sectionId', itemId: 'itemId' },
      body: { displayOrder: 1, priceOverrideMinor: '1200', labelOverride: 'Special' },
    },
  })
  putSectionItem(
    @ValidParams() params: { sectionId: string; itemId: string },
    @ValidBody() body: z.infer<typeof PutMenuSectionItemSchema>,
  ) {
    return this.menus.putSectionItem(params.sectionId, params.itemId, body);
  }

  @Delete('menu-sections/:sectionId/items/:itemId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.menu_section_item.delete',
    tags: TAGS,
    params: z.object({ sectionId: uuid, itemId: uuid }),
    status: 204,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: { params: { sectionId: 'sectionId', itemId: 'itemId' } },
  })
  async deleteSectionItem(
    @ValidParams() params: { sectionId: string; itemId: string },
  ): Promise<void> {
    await this.menus.deleteSectionItem(params.sectionId, params.itemId);
  }

  @Patch('menu-assignments/:assignmentId')
  @Contract({
    operationId: 'catalog.menu_assignment.update',
    tags: TAGS,
    params: idParam('assignmentId'),
    body: UpdateMenuAssignmentSchema,
    response: MenuAssignmentSchema,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: { ...fixtureParam('assignmentId'), body: { priority: 250 } },
  })
  updateAssignment(
    @ValidParams() params: { assignmentId: string },
    @ValidBody() body: z.infer<typeof UpdateMenuAssignmentSchema>,
  ) {
    return this.menus.updateAssignment(params.assignmentId, body);
  }

  @Delete('menu-assignments/:assignmentId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.menu_assignment.delete',
    tags: TAGS,
    params: idParam('assignmentId'),
    status: 204,
    permission: 'catalog.menu.manage',
    scope: TENANT,
    examples: fixtureParam('assignmentId'),
  })
  async deleteAssignment(@ValidParams() params: { assignmentId: string }): Promise<void> {
    await this.menus.deleteAssignment(params.assignmentId);
  }
}

@Controller('locations/:locationId/availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get()
  @Contract({
    operationId: 'catalog.availability.list',
    summary: 'The 86 list of a location',
    tags: TAGS,
    params: idParam('locationId'),
    query: AvailabilityListQuerySchema,
    response: ItemAvailabilityPageSchema,
    permission: 'catalog.view',
    scope: { kind: 'location', param: 'locationId' },
    examples: fixtureParam('locationId'),
  })
  list(
    @ValidParams() params: { locationId: string },
    @ValidQuery() query: z.infer<typeof AvailabilityListQuerySchema>,
  ) {
    return this.availability.list(params.locationId, query);
  }

  @Put()
  @Contract({
    operationId: 'catalog.availability.put',
    summary: 'Mark an item or variant unavailable (or available again) at a location',
    tags: TAGS,
    params: idParam('locationId'),
    body: PutItemAvailabilitySchema,
    response: ItemAvailabilitySchema,
    status: 200,
    permission: 'catalog.availability.manage',
    scope: { kind: 'location', param: 'locationId' },
    examples: {
      ...fixtureParam('locationId'),
      body: { itemId: '$fixture:itemId', isAvailable: false, reason: 'sold out' },
    },
  })
  put(
    @ValidParams() params: { locationId: string },
    @ValidBody() body: z.infer<typeof PutItemAvailabilitySchema>,
  ) {
    return this.availability.put(params.locationId, body);
  }

  @Delete(':availabilityId')
  @HttpCode(204)
  @Contract({
    operationId: 'catalog.availability.delete',
    tags: TAGS,
    params: z.object({ locationId: uuid, availabilityId: uuid }),
    status: 204,
    permission: 'catalog.availability.manage',
    scope: { kind: 'location', param: 'locationId' },
    examples: { params: { locationId: 'locationId', availabilityId: 'availabilityId' } },
  })
  async delete(
    @ValidParams() params: { locationId: string; availabilityId: string },
  ): Promise<void> {
    await this.availability.delete(params.locationId, params.availabilityId);
  }
}
