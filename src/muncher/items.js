// Main module class
import { updateCompendium, srdFiddling, daeFiddling, preFetchDDBIconImages } from "./import.js";
import DDBMuncher from "../apps/DDBMuncher.js";
import utils from "../lib/utils.js";
import FileHelper from "../lib/FileHelper.js";
import { getCobalt } from "../lib/Secrets.js";
import { getCampaignId } from "../lib/DDBCampaigns.js";
import logger from "../logger.js";
import SETTINGS from "../settings.js";
import DDBProxy from "../lib/DDBProxy.js";
import PatreonHelper from "../lib/PatreonHelper.js";
import DDBCharacter from "../parser/DDBCharacter.js";
import { applyChrisPremadeEffects } from "../effects/chrisPremades.js";
import { addVision5eStubs } from "../effects/vision5e.js";
import { configureDependencies } from "../effects/macros.js";

async function getCharacterInventory(items) {
  return items.map((item) => {
    return {
      chargesUsed: 0,
      definitionId: 0,
      definitionTypeId: 0,
      displayAsAttack: null,
      entityTypeId: 0,
      equipped: false,
      id: 0,
      isAttuned: false,
      quantity: item.bundleSize ? item.bundleSize : 1,
      definition: item,
    };
  });
}

async function generateImportItems(items) {
  const mockCharacter = {
    system: JSON.parse(utils.getTemplate("character")),
    type: "character",
    name: "",
    flags: {
      ddbimporter: {
        compendium: true,
        dndbeyond: {
          effectAbilities: [],
          totalLevels: 0,
          proficiencies: [],
          proficienciesIncludingEffects: [],
          characterValues: [],
        },
      },
    },
  };
  const mockDDB = {
    character: {
      classes: [],
      race: {
        racialTraits: [],
      },
      characterValues: [],
      inventory: items,
      customItems: null,
      options: {
        class: [],
        race: [],
        feat: [],
      },
      modifiers: {
        race: [],
        class: [],
        background: [],
        feat: [],
        item: [],
        condition: [],
      },
      feats: [],
    }
  };
  let itemSpells = []; // here we need to parse each available spell and build a mock spell parser
  const ddbCharacter = new DDBCharacter(mockDDB);
  ddbCharacter.raw.character = mockCharacter;
  ddbCharacter.source = {
    ddb: mockDDB
  };
  ddbCharacter.raw.itemSpells = [];
  const inventory = await ddbCharacter.getInventory();
  const results = {
    items: inventory,
    itemSpellNames: itemSpells, // this needs to be a list of spells to find
  };
  return results;
}

function getItemData(sourceFilter) {
  const cobaltCookie = getCobalt();
  const campaignId = getCampaignId();
  const parsingApi = DDBProxy.getProxy();
  const betaKey = PatreonHelper.getPatreonKey();
  const body = { cobalt: cobaltCookie, campaignId: campaignId, betaKey: betaKey };
  const debugJson = game.settings.get(SETTINGS.MODULE_ID, "debug-json");
  const enableSources = game.settings.get(SETTINGS.MODULE_ID, "munching-policy-use-source-filter");
  const sources = enableSources
    ? game.settings.get(SETTINGS.MODULE_ID, "munching-policy-muncher-sources").flat()
    : [];

  return new Promise((resolve, reject) => {
    fetch(`${parsingApi}/proxy/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body), // body data type must match "Content-Type" header
    })
      .then((response) => response.json())
      .then((data) => {
        if (debugJson) {
          FileHelper.download(JSON.stringify(data), `items-raw.json`, "application/json");
        }
        if (!data.success) {
          DDBMuncher.munchNote(`Failure: ${data.message}`);
          reject(data.message);
        }
        return data;
      })
      .then((data) => {
        if (sources.length == 0 || !sourceFilter) return data.data;
        return data.data.filter((item) =>
          item.sources.some((source) => sources.includes(source.sourceId))
        );
      })
      .then((data) => {
        if (sources.length > 0) return data;
        if (game.settings.get(SETTINGS.MODULE_ID, "munching-policy-item-homebrew-only")) {
          return data.filter((item) => item.isHomebrew);
        } else if (!game.settings.get(SETTINGS.MODULE_ID, "munching-policy-item-homebrew")) {
          return data.filter((item) => !item.isHomebrew);
        } else {
          return data;
        }
      })
      .then((data) => getCharacterInventory(data))
      .then((items) => generateImportItems(items))
      .then((data) => resolve(data))
      .catch((error) => reject(error));
  });
}

export async function addMagicItemSpells(items, spells, updateBool) {
  if (spells.length === 0) return;
  const itemSpells = await updateCompendium("itemspells", { itemspells: spells }, updateBool);
  // scan the inventory for each item with spells and copy the imported data over
  items.forEach((item) => {
    if (item.flags.magicitems.spells) {
      for (let [i, spell] of Object.entries(item.flags.magicitems.spells)) {
        const itemSpell = itemSpells.find((item) => item.name === spell.name);
        if (itemSpell) {
          for (const [key, value] of Object.entries(itemSpell)) {
            item.flags.magicitems.spells[i][key] = value;
          }
        }
      }
    }
  });
}

export async function parseItems(ids = null) {
  const updateBool = game.settings.get(SETTINGS.MODULE_ID, "munching-policy-update-existing");
  const magicItemsInstalled = !!game.modules.get("magicitems");
  const uploadDirectory = game.settings.get(SETTINGS.MODULE_ID, "other-image-upload-directory").replace(/^\/|\/$/g, "");

  // to speed up file checking we pregenerate existing files now.
  logger.info("Checking for existing files...");
  await FileHelper.generateCurrentFiles(uploadDirectory);
  logger.info("Check complete, getting ItemData.");

  await DDBMuncher.generateCompendiumFolders("items");

  if (!CONFIG.DDBI.EFFECT_CONFIG.MODULES.configured) {
    // eslint-disable-next-line require-atomic-updates
    CONFIG.DDBI.EFFECT_CONFIG.MODULES.configured = await configureDependencies();
  }

  DDBMuncher.munchNote("Downloading item data..");

  // disable source filter if ids provided
  const sourceFilter = !(ids !== null && ids.length > 0);
  const results = await getItemData(sourceFilter);
  let items = results.items;

  DDBMuncher.munchNote("Parsing item data..");

  // Items Spell addition is currently not done, parsing out spells needs to be addded
  // let itemSpells = results.value.itemSpells;
  let itemSpells = null;

  // store all spells in the folder specific for Dynamic Items
  if (magicItemsInstalled && itemSpells && Array.isArray(itemSpells)) {
    await addMagicItemSpells(items, itemSpells, updateBool);
  }

  await preFetchDDBIconImages();

  const srdItems = await srdFiddling(items, "inventory");
  const filteredItems = (ids !== null && ids.length > 0)
    ? srdItems.filter((s) => s.flags?.ddbimporter?.definitionId && ids.includes(String(s.flags.ddbimporter.definitionId)))
    : srdItems;
  const daeItems = await daeFiddling(filteredItems);
  const vision5eItems = addVision5eStubs(daeItems);
  const finalItems = await applyChrisPremadeEffects({ documents: vision5eItems, compendiumItem: true });

  const finalCount = finalItems.length;
  DDBMuncher.munchNote(`Importing ${finalCount} items!`, true);
  logger.time("Item Import Time");

  const updateResults = await updateCompendium("inventory", { inventory: finalItems }, updateBool);
  const updatePromiseResults = await Promise.all(updateResults);

  logger.debug({ finalItems, updateResults, updatePromiseResults });
  DDBMuncher.munchNote("");
  logger.timeEnd("Item Import Time");
  return updateResults;
}


