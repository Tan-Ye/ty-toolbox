using System;
using System.Collections.Generic;
using System.Reflection;
using Duckov.Endowment;
using ItemStatsSystem;
using SodaCraft.Localizations;
using UnityEngine;

namespace GuozuYa
{
    /// <summary>
    /// 在「选择天赋」界面新增「祖国鸭」：
    /// 复制其他所有天赋的正面属性（Modifier），跳过所有负面属性。
    /// </summary>
    public class ModBehaviour : Duckov.Modding.ModBehaviour
    {
        // 自定义天赋索引，避开原版 EndowmentIndex 的取值（0~4）
        private const int EndowmentValue = 100;
        private const string DisplayNameKey = "Endowmment_100";
        private const string DescriptionKey = "Endowmment_100_Desc";
        private const string RequirementKey = "GuozuYa_Requirement";

        private static readonly FieldInfo IndexField = GetEndowmentField("index");
        private static readonly FieldInfo IconField = GetEndowmentField("icon");
        private static readonly FieldInfo RequirementField = GetEndowmentField("requirementTextKey");
        private static readonly FieldInfo UnlockedByDefaultField = GetEndowmentField("unlockedByDefault");
        private static readonly FieldInfo ModifiersField = GetEndowmentField("modifiers");

        private static readonly FieldInfo EntriesField =
            typeof(EndowmentManager).GetField("entries", BindingFlags.Instance | BindingFlags.NonPublic);

        private static readonly FieldInfo EntriesReadOnlyField =
            typeof(EndowmentManager).GetField("_entries_ReadOnly", BindingFlags.Instance | BindingFlags.NonPublic);

        private EndowmentManager manager;
        private EndowmentEntry entry;
        private Sprite icon;
        private Item lastAppliedItem;

        private static FieldInfo GetEndowmentField(string name)
        {
            return typeof(EndowmentEntry).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
        }

        private void Awake()
        {
            LocalizationManager.SetOverrideText(DisplayNameKey, "祖国鸭");
            LocalizationManager.SetOverrideText(DescriptionKey, "我想做什么就做什么....");
            LocalizationManager.SetOverrideText(RequirementKey, "无条件");
            Debug.Log("[GuozuYa] 祖国鸭 mod loaded.");
        }

        protected override void OnBeforeDeactivate()
        {
            if (entry != null)
            {
                entry.Deactivate();
            }
        }

        private void Update()
        {
            // EndowmentManager 随场景创建/重建，这里做一次轻量的看护
            EndowmentManager current = EndowmentManager.Instance;
            if (current != null && (current != manager || entry == null))
            {
                Inject(current);
            }

            EnsureAppliedOnCharacter();
        }

        /// <summary>
        /// 游戏在 OnLevelInitialized 里应用天赋时，CharacterMainControl.Main
        /// 可能还未就绪，导致激活被跳过。这里在角色真正出现后补应用一次。
        /// </summary>
        private void EnsureAppliedOnCharacter()
        {
            if (entry == null || !LevelManager.LevelInited || !LevelConfig.SaveCharacter)
            {
                return;
            }

            CharacterMainControl main = CharacterMainControl.Main;
            if (main == null)
            {
                return;
            }

            Item item = main.CharacterItem;
            if (item == null || item == lastAppliedItem)
            {
                return;
            }

            if (EndowmentManager.SelectedIndex != (EndowmentIndex)EndowmentValue)
            {
                return;
            }

            entry.Activate();
            lastAppliedItem = item;
            Debug.Log("[GuozuYa] 已确保「祖国鸭」加成应用到当前角色。");
        }

        private void Inject(EndowmentManager target)
        {
            try
            {
                PrepareEntry(target);

                if (!(EntriesField?.GetValue(target) is List<EndowmentEntry> entries))
                {
                    Debug.LogError("[GuozuYa] 无法访问 EndowmentManager.entries。");
                    return;
                }

                if (!entries.Contains(entry))
                {
                    entries.Add(entry);
                }

                // entries 的只读缓存需要失效，天赋选择界面才能看到新天赋
                EntriesReadOnlyField?.SetValue(target, null);
                manager = target;

                if (EndowmentManager.SelectedIndex == (EndowmentIndex)EndowmentValue)
                {
                    entry.Activate();
                }

                Debug.Log($"[GuozuYa] 已注入「祖国鸭」天赋，共复制 {entry.Modifiers.Length} 条正面属性。");
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
        }

        private void PrepareEntry(EndowmentManager target)
        {
            if (entry == null)
            {
                GameObject go = new GameObject("Endowment_GuozuYa");
                go.transform.SetParent(target.transform, false);
                entry = go.AddComponent<EndowmentEntry>();
            }
            else if (entry.transform.parent != target.transform)
            {
                entry.transform.SetParent(target.transform, false);
            }

            SetValue(IndexField, (EndowmentIndex)EndowmentValue);
            SetValue(IconField, LoadIcon());
            SetValue(RequirementField, RequirementKey);
            SetValue(UnlockedByDefaultField, true);
            SetValue(ModifiersField, CollectBeneficialModifiers(target));
        }

        private void SetValue(FieldInfo field, object value)
        {
            if (field == null)
            {
                Debug.LogError("[GuozuYa] EndowmentEntry 字段不存在，游戏版本可能已变化。");
                return;
            }

            field.SetValue(entry, value);
        }

        /// <summary>
        /// 汇总其他所有天赋的正面属性。Modifier 的 value 为正即对玩家有利：
        /// Add/PercentageAdd 为加成，PercentageMultiply 为倍率提升。
        /// </summary>
        private EndowmentEntry.ModifierDescription[] CollectBeneficialModifiers(EndowmentManager target)
        {
            List<EndowmentEntry.ModifierDescription> result = new List<EndowmentEntry.ModifierDescription>();

            foreach (EndowmentEntry other in target.Entries)
            {
                if (other == null || other == entry)
                {
                    continue;
                }

                EndowmentEntry.ModifierDescription[] modifiers = other.Modifiers;
                if (modifiers == null)
                {
                    continue;
                }

                foreach (EndowmentEntry.ModifierDescription modifier in modifiers)
                {
                    if (modifier.value > 0f)
                    {
                        // 数值两倍提升
                        modifier.value *= 2f;
                        result.Add(modifier);
                    }
                    else
                    {
                        Debug.Log($"[GuozuYa] 跳过负面属性：{other.DisplayName} {modifier.statKey} {modifier.type} {modifier.value}");
                    }
                }
            }

            return result.ToArray();
        }

        private Sprite LoadIcon()
        {
            if (icon != null)
            {
                return icon;
            }

            try
            {
                Texture2D texture = info.preview;
                if (texture == null)
                {
                    return null;
                }

                icon = Sprite.Create(texture, new Rect(0f, 0f, texture.width, texture.height), new Vector2(0.5f, 0.5f), 100f);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }

            return icon;
        }
    }
}
