import path from "path";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type GuildMember,
  type Guild,
  type Message,
  type Role,
} from "discord.js";
import banStore from "./banStore";
import { resolveWelcomeChannel } from "./welcome";

const log = {
  info:  (...a: unknown[]) => console.log("[INFO]", ...a),
  warn:  (...a: unknown[]) => console.warn("[WARN]", ...a),
  error: (...a: unknown[]) => console.error("[ERROR]", ...a),
};

const PREFIX       = process.env["COMMAND_PREFIX"]        || "!";
const MOD_ROLE_NAME = process.env["MODERATOR_ROLE_NAME"]  || "moderator";
const MOD_ROLE_ID   = process.env["MODERATOR_ROLE_ID"]    || "1535405839316156537";
const APPROVAL_CH   = process.env["ROLE_APPROVAL_CHANNEL_ID"] || "111111111111111111111";
const WELCOME_CH    = process.env["WELCOME_CHANNEL_ID"]   || "11111111111111111";
const TOKEN         = process.env["DISCORD_TOKEN"]; 

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set — exiting.");
  process.exit(1);
}

const REQUESTABLE_ROLE_IDS = [
  "11111111111111111111",
  "1111111111111111",
  "1111111111111",
];

const AUTO_GRANT_INVITE_CODE = process.env["AUTO_GRANT_INVITE_CODE"] || "default-invite";
const AUTO_GRANT_ROLE_ID = process.env["AUTO_GRANT_ROLE_ID"] || "11111111111111111";
const BAN_SUBMIT_ROLE_IDS = [
  "1530688899129802884",
  "1539635257693966336",
];
const BAN_LOG_CHANNEL_ID = process.env["BAN_LOG_CHANNEL_ID"] || "1530688900316532736";
const BAN_LEADERBOARD_CHANNEL_ID = process.env["BAN_LEADERBOARD_CHANNEL_ID"] || "1530688900048355439";
const DEDICATED_BAN_LOG_CHANNEL_ID = process.env["DEDICATED_BAN_LOG_CHANNEL_ID"] || "1530688900048355438";

const pendingRequests = new Map<
  string,
  { userId: string; roleId: string; roleName: string; nickname: string; inGameId: string; approvalChannelId: string }
>();
const guildInviteCache = new Map<string, any>();

function hasModeratorRole(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  if (member.permissions?.has(PermissionsBitField.Flags.ManageRoles)) return true;
  return member.roles.cache.some(
    (r) => r.name.toLowerCase() === MOD_ROLE_NAME.toLowerCase() || r.id === MOD_ROLE_ID,
  );
}

function hasBanSubmissionRole(member: GuildMember | null | undefined): boolean {
  if (!member) return false;
  if (hasModeratorRole(member)) return true;

  return member.roles.cache.some((r) => BAN_SUBMIT_ROLE_IDS.includes(r.id));
}

async function buildLeaderboardEmbed(guildId: string) {
  const leaderboard = banStore.getLeaderboard(guildId).slice(0, 10);
  const guild = client.guilds.cache.get(guildId);
  const serverName = guild?.name ?? "Server";
  const embed = new EmbedBuilder().setTitle("Ban Leaderboard").setColor("#ff0000");
  embed.setAuthor({ name: serverName, iconURL: guild?.iconURL() ?? client.user?.displayAvatarURL() ?? undefined });
  embed.setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null);
  embed.setFooter({ text: "Updating Live" });

  if (leaderboard.length === 0) {
    embed.setDescription("No bans logged yet.");
    return embed;
  }

  const lines = leaderboard.map(([modId, count]) => `<@${modId}> — ${count}`);
  embed.setDescription(lines.join("\n"));
  return embed;
}

async function findExistingLeaderboardMessage(guildId: string, channel: any): Promise<Message | null> {
  if (!channel || !("messages" in channel)) return null;

  const mapping = banStore.getLeaderboardMessage(guildId);
  if (mapping && mapping.channelId === channel.id) {
    const mapped = await channel.messages.fetch(mapping.messageId).catch(() => null);
    if (mapped) return mapped;
  }

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;

  const existing = messages.find((m: Message) => m.embeds.length > 0 && m.embeds[0].title === "Ban Leaderboard");
  if (existing) {
    banStore.setLeaderboardMessage(guildId, channel.id, existing.id);
    return existing;
  }

  return null;
}

function resolveRole(guild: Guild, input: string) {
  const mention = input.match(/^<@&?(\d+)>$/);
  if (mention) return guild.roles.cache.get(mention[1]!) ?? null;
  if (/^\d{17,20}$/.test(input)) return guild.roles.cache.get(input) ?? null;
  return guild.roles.cache.find((r) => r.name.toLowerCase() === input.toLowerCase()) ?? null;
}

async function resolveMember(guild: Guild, input: string) {
  const mention = input.match(/^<@!?(\d+)>$/);
  if (mention) return guild.members.fetch(mention[1]!).catch(() => null);
  if (/^\d{17,20}$/.test(input)) return guild.members.fetch(input).catch(() => null);
  return null;
}

function buildApprovalEmbed(r: { userId: string; roleName: string; nickname: string; inGameId: string }) {
  return new EmbedBuilder()
    .setColor("#00bfff")
    .setTitle("Role request review")
    .setDescription("A new role request needs review.")
    .addFields(
      { name: "User", value: `<@${r.userId}>`, inline: true },
      { name: "Requested role", value: r.roleName, inline: true },
      { name: "Display name", value: r.nickname, inline: true },
      { name: "ID", value: r.inGameId || "—", inline: true },
    )
    .setTimestamp();
}

async function refreshGuildInvites(guild: Guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) guildInviteCache.set(guild.id, invites);
  return invites;
}

async function getGuildVanityCode(guild: Guild): Promise<string | null> {
  try {
    const vanityData = await guild.fetchVanityData().catch(() => null);
    if (vanityData?.code) return vanityData.code.toLowerCase();
  } catch {}
  return guild.vanityURLCode?.toLowerCase() ?? null;
}

function findInviteUsed(before: any, after: any) {
  if (!before || !after) return null;
  for (const [code, invite] of after.entries()) {
    const previous = before.get(code);
    if (!previous) continue;
    const nextUses = invite?.uses ?? 0;
    const prevUses = previous?.uses ?? 0;
    if (nextUses > prevUses) return invite;
  }
  return null;
}

function buildRoleSelectionRows(roles: Role[]) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  roles.forEach((role, i) => {
    const ri = Math.floor(i / 5);
    if (!rows[ri]) rows[ri] = new ActionRowBuilder<ButtonBuilder>();
    rows[ri]!.addComponents(
      new ButtonBuilder().setCustomId(`select-role:${role.id}`).setLabel(role.name).setStyle(ButtonStyle.Secondary),
    );
  });
  return rows;
}

function buildRequestButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("request-role")
      .setLabel("⚔️  — Request a Role —  ⚔️")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildBanButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("submit-ban")
      .setLabel("Submit Ban Log")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildDmComposerButton(roleId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`dm-compose:${roleId}`)
      .setLabel("Open DM Input")
      .setStyle(ButtonStyle.Primary),
  );
}

function cleanup(msg: Message, delay = 10000) {
  setTimeout(() => msg.delete().catch(() => {}), delay);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => log.info(`Discord bot ready: ${client.user?.tag}`));

client.on("error",          (e)      => log.error("Client error:", e));
client.on("shardError",     (e)      => log.error("Shard error:", e));
client.on("shardDisconnect",(ev, id) => log.warn(`Shard ${id} disconnected (${ev.code}) — will reconnect`));
client.on("shardReconnecting",(id)   => log.info(`Shard ${id} reconnecting...`));
client.on("shardResume",    (id)     => log.info(`Shard ${id} resumed`));

process.on("unhandledRejection", (r) => log.error("Unhandled rejection:", r));

// Periodic leaderboard updater: edit stored leaderboard messages every 5 minutes
async function updateAllLeaderboards() {
  try {
    const map = banStore.getAllLeaderboardMappings();
    for (const [guildId, info] of Object.entries(map) as [string, { channelId: string; messageId: string }][]) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const ch = guild.channels.cache.get(info.channelId);
      if (!ch || !("messages" in ch)) continue;
      const msg = await (ch as any).messages.fetch(info.messageId).catch(() => null);
      if (!msg) continue;
      const lbEmbed = await buildLeaderboardEmbed(guildId);
      await msg.edit({ embeds: [lbEmbed] }).catch(() => {});
    }
  } catch (e) { log.error("updateAllLeaderboards:", e); }
}

client.once("ready", async () => {
  updateAllLeaderboards().catch(() => {});
  for (const [, guild] of client.guilds.cache) {
    await refreshGuildInvites(guild).catch(() => {});
  }
  setInterval(() => updateAllLeaderboards().catch(() => {}), 5 * 60 * 1000);
});

client.on("guildCreate", async (guild) => {
  await refreshGuildInvites(guild).catch(() => {});
});

client.on("guildMemberAdd", async (member) => {
  try {
    const configuredCode = AUTO_GRANT_INVITE_CODE.toLowerCase();
    const vanityCode = await getGuildVanityCode(member.guild);
    const beforeInvites = guildInviteCache.get(member.guild.id);
    const afterInvites = await refreshGuildInvites(member.guild);
    const usedInvite = findInviteUsed(beforeInvites, afterInvites);
    const usedInviteCode = usedInvite?.code?.toLowerCase();
    const shouldGrant = Boolean(vanityCode && vanityCode === configuredCode) || Boolean(usedInviteCode && usedInviteCode === configuredCode);

    if (shouldGrant) {
      const rewardRole = await member.guild.roles.fetch(AUTO_GRANT_ROLE_ID).catch(() => null);
      if (rewardRole) {
        await member.roles.add(rewardRole, "Joined via configured invite");
      } else {
        log.warn(`Auto-grant role ${AUTO_GRANT_ROLE_ID} not found in guild ${member.guild.id}`);
      }
    }
  } catch (e) {
    log.error("Failed to process invite-based auto-role:", e);
  }

  const channel = member.guild.channels.cache.get(WELCOME_CH);
  if (!channel?.isTextBased()) {
    log.warn(`Welcome channel ${WELCOME_CH} not available for guild ${member.guild.id}`);
    return;
  }

  const n = member.guild.memberCount;
  const embed = new EmbedBuilder()
    .setColor("#22c55e")
    .setTitle(`Welcome to ${member.guild.name}!`)
    .setDescription(`Hey ${member.toString()}, welcome to **${member.guild.name}**!\nYou are the **${n}th** member!`)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `Member #${n}` })
    .setTimestamp();
  await channel.send({
    content: `Welcome ${member.toString()} to **${member.guild.name}**! You are the **${n}th** member!`,
    embeds: [embed],
  }).catch((e) => log.error("Failed to send welcome:", e));
});

client.on("interactionCreate", async (interaction): Promise<void> => {
  if (!interaction.guild) return;

  if (interaction.isButton()) {
    if (interaction.customId.startsWith("dm-compose:")) {
      if (!hasModeratorRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can send DMs.", ephemeral: true });
        return;
      }
      const roleId = interaction.customId.split(":")[1]!;
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        await interaction.reply({ content: "That role is no longer available.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId(`dm-submit:${role.id}`).setTitle(`Send DM To • ${role.name}`);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("dmTitle").setLabel("Subject / Heading").setStyle(TextInputStyle.Short).setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("dmMessage").setLabel("Message").setStyle(TextInputStyle.Paragraph).setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === "submit-ban") {
      if (!hasBanSubmissionRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can submit bans.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder().setCustomId("ban-submit").setTitle("Submit Ban");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("bannedId").setLabel("Banned user ID").setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("reason").setLabel("Reason (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === "request-role") {
      await interaction.deferReply({ ephemeral: true });
      const roles = REQUESTABLE_ROLE_IDS
        .map((id) => interaction.guild!.roles.cache.get(id))
        .filter((r): r is Role => !!r)
        .sort((a, b) => b.position - a.position);
      if (!roles.length) {
        await interaction.editReply({ content: "No selectable roles are available." });
        return;
      }
      await interaction.editReply({ content: "Choose the role you want to request:", components: buildRoleSelectionRows(roles) });
      return;
    }

    if (interaction.customId.startsWith("select-role:")) {
      const roleId = interaction.customId.split(":")[1]!;
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) { await interaction.reply({ content: "That role is no longer available.", ephemeral: true }); return; }
      const modal = new ModalBuilder().setCustomId(`role-details:${role.id}`).setTitle("Role request details");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("requestedName").setLabel("Your desired display name").setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId("requestedDiscordId").setLabel("Your ID (optional)").setStyle(TextInputStyle.Short).setRequired(false),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith("role-approve:") || interaction.customId.startsWith("role-decline:")) {
      if (!hasModeratorRole(interaction.member as GuildMember)) {
        await interaction.reply({ content: "Only moderators can approve or decline role requests.", ephemeral: true });
        return;
      }
      const requestId = interaction.customId.split(":")[1]!;
      const request = pendingRequests.get(requestId);
      if (!request) { await interaction.reply({ content: "That request is no longer available.", ephemeral: true }); return; }

      const targetMember = await resolveMember(interaction.guild, request.userId);
      const role = resolveRole(interaction.guild, request.roleId);
      if (!targetMember || !role) {
        pendingRequests.delete(requestId);
        await interaction.reply({ content: "Member or role no longer available.", ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith("role-approve:")) {
        try {
          const verificationRole = interaction.guild.roles.cache.get(AUTO_GRANT_ROLE_ID);
          if (verificationRole) await targetMember.roles.remove(verificationRole, "Removed after role request approved");
          await targetMember.roles.add(role, "Approved via button");
        } catch {
          await interaction.reply({ content: "Could not update the member's roles.", ephemeral: true }); return;
        }
        const nick = request.inGameId
          ? `ORD |⚔️ ${request.nickname} | ${request.inGameId}`
          : `ORD |⚔️ ${request.nickname}`;
        await targetMember.setNickname(nick).catch(() => {});
        await targetMember.send(`Your role request for ${role.name} was approved. Nickname: ${nick}`).catch(() => {});
        pendingRequests.delete(requestId);
        await interaction.update({
          embeds: [new EmbedBuilder().setColor("#22c55e").setTitle("Role request approved").setDescription(`Approved for ${targetMember.user.tag}`).setTimestamp()],
          components: [],
        });
        cleanup(interaction.message as Message, 10000);
        return;
      }

      await targetMember.send(`Your role request for ${role.name} was declined.`).catch(() => {});
      pendingRequests.delete(requestId);
      await interaction.update({
        embeds: [new EmbedBuilder().setColor("#ef4444").setTitle("Role request declined").setDescription(`Declined for ${targetMember.user.tag}`).setTimestamp()],
        components: [],
      });
      cleanup(interaction.message as Message, 10000);
    }
  }

  // Modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("dm-submit:")) {
    if (!hasModeratorRole(interaction.member as GuildMember)) { await interaction.reply({ content: "Only moderators can send DMs.", ephemeral: true }); return; }
    const roleId = interaction.customId.split(":")[1]!;
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) { await interaction.reply({ content: "That role is no longer available.", ephemeral: true }); return; }

    const titleInput = interaction.fields.getTextInputValue("dmTitle").trim();
    const messageText = interaction.fields.getTextInputValue("dmMessage").replace(/\r\n/g, "\n");
    if (!messageText.trim()) { await interaction.reply({ content: "You must enter a message.", ephemeral: true }); return; }

    await interaction.deferReply({ ephemeral: true });
    await interaction.guild.members.fetch();
    const members = interaction.guild.members.cache.filter((m) => m.roles.cache.has(role.id) && !m.user.bot);
    const embed = new EmbedBuilder()
      .setColor("#2563eb")
      .setTitle(titleInput || "Order Team")
      .setDescription(messageText)
      .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
      .setFooter({ text: `${interaction.guild.name} • Sent by ${interaction.user.username}` })
      .setTimestamp();

    let sent = 0, failed = 0;
    for (const [, member] of members) {
      try { await member.send({ embeds: [embed] }); sent++; } catch { failed++; }
    }

    await interaction.editReply({ content: `✅ DM sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.` });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "ban-submit") {
    if (!hasBanSubmissionRole(interaction.member as GuildMember)) { await interaction.reply({ content: "Only moderators can submit ban logs.", ephemeral: true }); return; }
    const bannedId = interaction.fields.getTextInputValue("bannedId").trim();
    const reason = interaction.fields.getTextInputValue("reason").trim();
    if (!bannedId) { await interaction.reply({ content: "You must enter the banned user's ID.", ephemeral: true }); return; }
    const moderatorId = (interaction.member as GuildMember).id;
    try {
      banStore.addBan(moderatorId, bannedId, reason || undefined, interaction.guild.id);
    } catch (e) { log.error("banStore.addBan:", e); }

    const embed = new EmbedBuilder()
      .setColor("#ef4444")
      .setTitle("Ban Log Submitted")
      .addFields(
        { name: "Moderator", value: `<@${moderatorId}>`, inline: true },
        { name: "Banned ID", value: bannedId, inline: true },
        { name: "Reason", value: reason || "—", inline: false },
      )
      .setTimestamp();

    const banLogTargetChannelId = "1530688900316532736";
    const targetChannel =
      interaction.guild.channels.cache.get(banLogTargetChannelId) ??
      (await client.channels.fetch(banLogTargetChannelId).catch(() => null));

    if (targetChannel && "send" in targetChannel) {
      try {
        await (targetChannel as any).send({ embeds: [embed] });
      } catch (e) {
        log.error("Failed to send ban log message to configured channel:", e);
      }
    } else {
      log.warn("Ban log channel not found or not text-based:", banLogTargetChannelId);
    }

    if (BAN_LEADERBOARD_CHANNEL_ID) {
      const lbCh = interaction.guild.channels.cache.get(BAN_LEADERBOARD_CHANNEL_ID);
      if (lbCh && "send" in lbCh) {
        const lbEmbed = await buildLeaderboardEmbed(interaction.guild.id);
        try {
          const mapping = banStore.getLeaderboardMessage(interaction.guild.id);
          if (mapping) {
            const ch = interaction.guild.channels.cache.get(mapping.channelId);
            if (ch && "messages" in ch) {
              const msg = await (ch as any).messages.fetch(mapping.messageId).catch(() => null);
              if (msg) {
                await msg.edit({ embeds: [lbEmbed] });
              } else {
                const sent = await (lbCh as any).send({ embeds: [lbEmbed] });
                banStore.setLeaderboardMessage(interaction.guild.id, (lbCh as any).id, sent.id);
              }
            } else {
              const sent = await (lbCh as any).send({ embeds: [lbEmbed] });
              banStore.setLeaderboardMessage(interaction.guild.id, (lbCh as any).id, sent.id);
            }
          } else {
            const sent = await (lbCh as any).send({ embeds: [lbEmbed] });
            banStore.setLeaderboardMessage(interaction.guild.id, (lbCh as any).id, sent.id);
          }
        } catch (e) { log.error("Failed to send/edit leaderboard:", e); }
      }
    }

    await interaction.reply({ content: "Ban log recorded.", ephemeral: true });
    setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("role-details:")) {
    const roleId = interaction.customId.split(":")[1]!;
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) { await interaction.reply({ content: "That role is no longer available.", ephemeral: true }); return; }

    const name = interaction.fields.getTextInputValue("requestedName").trim();
    const inGameId = interaction.fields.getTextInputValue("requestedDiscordId").trim();
    if (!name) { await interaction.reply({ content: "You must enter a name.", ephemeral: true }); return; }

    const targetMember = interaction.member as GuildMember;
    const approvalChannel = APPROVAL_CH
      ? interaction.guild.channels.cache.get(APPROVAL_CH)
      : interaction.channel;

    if (!approvalChannel || !("send" in approvalChannel)) {
      await interaction.reply({ content: "Approval channel not configured.", ephemeral: true }); return;
    }

    const ch = approvalChannel as { send: Function; id: string };
    const approvalMsg = await ch.send({
      embeds: [buildApprovalEmbed({ userId: targetMember.id, roleName: role.name, nickname: name, inGameId })],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("role-approve:pending").setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("role-decline:pending").setLabel("Decline").setStyle(ButtonStyle.Danger),
      )],
    });

    await approvalMsg.edit({
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`role-approve:${approvalMsg.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`role-decline:${approvalMsg.id}`).setLabel("Decline").setStyle(ButtonStyle.Danger),
      )],
    });

    pendingRequests.set(approvalMsg.id, { userId: targetMember.id, roleId: role.id, roleName: role.name, nickname: name, inGameId, approvalChannelId: ch.id });
    await interaction.reply({ content: "Your request has been sent to moderators for review.", ephemeral: true });
  }
});

client.on("messageCreate", async (message): Promise<void> => {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  if (command === "setuprolebutton") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#2b2d31")
          .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() ?? undefined })
          .setTitle("⚔️  Role Request")
          .setDescription("\u200b\nA moderator will review your request and approve or decline it.\n\u200b")
          .addFields({ name: "📋  How it works", value: "1. Click the button below\n2. Select the role you want\n3. Enter your city name and ID\n4. Wait for moderator approval" })
          .setThumbnail(message.guild.iconURL())
          .setFooter({ text: `${message.guild.name} • Role System` })
          .setTimestamp(),
      ],
      components: [buildRequestButton()],
    });
    return;
  }

  if (command === "setupbanbutton") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    await message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor("#ff0000")
          .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() ?? undefined })
          .setTitle("Submit A Ban")
          .setDescription("Please don't submit old Ban logs Into the Bot.")
          .setThumbnail(message.guild.iconURL())
          .setFooter({ text: `${message.guild.name} • Moderation Logs` })
          .setTimestamp(),
      ],
      components: [buildBanButton()],
    });
    return;
  }

  if (command === "banlogs") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const targetArg = args[0];
    let moderatorId = message.author.id;
    if (targetArg) {
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      if (mention) moderatorId = mention[1]!;
      else if (/^\d{17,20}$/.test(targetArg)) moderatorId = targetArg;
    }
    const bans = banStore.getBansByModerator(moderatorId, message.guild.id);
    const user = await client.users.fetch(moderatorId).catch(() => null);
    const embed = new EmbedBuilder().setTitle(`Ban logs for ${user ? user.tag : moderatorId}`).setColor("#ef4444");
    if (!bans.length) embed.setDescription("No bans recorded for that moderator.");
    else {
      embed.addFields({ name: "Total", value: String(bans.length), inline: true });
      const lines = bans.slice(-25).map((b) => `• ${b.targetId} — ${b.reason || "—"} — ${new Date(b.timestamp).toLocaleString()}`);
      embed.addFields({ name: "Recent bans", value: lines.join("\n") });
    }
    const r = await message.channel.send({ embeds: [embed] });
    cleanup(r, 30000);
    return;
  }

  if (command === "banleaderboard") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const embed = await buildLeaderboardEmbed(message.guild.id);
    if (BAN_LEADERBOARD_CHANNEL_ID) {
      const lbCh = message.guild.channels.cache.get(BAN_LEADERBOARD_CHANNEL_ID);
      if (lbCh && "send" in lbCh) {
        try {
          const mapping = banStore.getLeaderboardMessage(message.guild.id);
          if (mapping) {
            const ch = message.guild.channels.cache.get(mapping.channelId);
            if (ch && "messages" in ch) {
              const msg = await (ch as any).messages.fetch(mapping.messageId).catch(() => null);
              if (msg) { await msg.edit({ embeds: [embed] }); }
              else { const sent = await (lbCh as any).send({ embeds: [embed] }); banStore.setLeaderboardMessage(message.guild.id, (lbCh as any).id, sent.id); }
            } else { const sent = await (lbCh as any).send({ embeds: [embed] }); banStore.setLeaderboardMessage(message.guild.id, (lbCh as any).id, sent.id); }
          } else { const sent = await (lbCh as any).send({ embeds: [embed] }); banStore.setLeaderboardMessage(message.guild.id, (lbCh as any).id, sent.id); }
        } catch (e) { log.error("Failed to send/edit leaderboard:", e); }
        const info = await message.channel.send(`Leaderboard posted to <#${BAN_LEADERBOARD_CHANNEL_ID}>`);
        cleanup(info, 10000);
      } else {
        await message.channel.send({ embeds: [embed] });
      }
    } else {
      await message.channel.send({ embeds: [embed] });
    }
    return;
  }

  if (command === "addcargo") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, userArg] = args;
    if (!roleArg || !userArg) { const r = await message.reply(`Usage: ${PREFIX}addcargo @role userId`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    const target = await resolveMember(message.guild, userArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    if (!target) { const r = await message.reply("Could not find that user."); cleanup(r); return; }
    message.delete().catch(() => {});
    try {
      await target.roles.add(role, "Assigned by moderator command");
      const now = new Date();
      const embed = new EmbedBuilder()
        .setColor("#22c55e").setTitle("✅ Role added")
        .addFields(
          { name: "Server", value: message.guild.name, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Date and time", value: `${now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`, inline: true },
          { name: "Role", value: `${role.name}\n${role.id}`, inline: true },
          { name: "Executed by", value: `${message.author.username}\n${message.member?.toString()}\n${message.author.id}`, inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "Successfully added", value: `${target.toString()} ${target.user.username}\n( ${target.id} )` },
        )
        .setThumbnail(message.guild.iconURL()).setTimestamp();
      const r = await message.channel.send({ embeds: [embed] });
      cleanup(r, 10000);
    } catch (e) { log.error("addcargo:", e); const r = await message.channel.send("Could not assign that role."); cleanup(r); }
    return;
  }

  if (command === "remcargo") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, userArg] = args;
    if (!roleArg || !userArg) { const r = await message.reply(`Usage: ${PREFIX}remcargo @role userId`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    const target = await resolveMember(message.guild, userArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    if (!target) { const r = await message.reply("Could not find that user."); cleanup(r); return; }
    try {
      await message.delete().catch(() => {});
      await target.roles.remove(role, "Removed by moderator command");
      const now = new Date();
      const embed = new EmbedBuilder()
        .setColor("#ef4444").setTitle("🗑️ Role removed")
        .addFields(
          { name: "Server", value: message.guild.name, inline: true },
          { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
          { name: "Date and time", value: `${now.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`, inline: true },
          { name: "Role", value: `${role.name}\n${role.id}`, inline: true },
          { name: "Executed by", value: `${message.author.username}\n${message.member?.toString()}\n${message.author.id}`, inline: true },
          { name: "\u200b", value: "\u200b", inline: true },
          { name: "Successfully removed", value: `${target.toString()} ${target.user.username}\n( ${target.id} )` },
        )
        .setThumbnail(message.guild.iconURL()).setTimestamp();
      const r = await message.channel.send({ embeds: [embed] });
      cleanup(r, 10000);
    } catch (e) { log.error("remcargo:", e); const r = await message.channel.send("Could not remove that role."); cleanup(r); }
    return;
  }

  if (command === "dm") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    const [roleArg, ...messageParts] = args;
    const dmText = messageParts.join(" ").trim();
    if (!roleArg) { const r = await message.reply(`Usage: ${PREFIX}dm @role [message]`); cleanup(r); return; }
    const role = resolveRole(message.guild, roleArg);
    if (!role) { const r = await message.reply("Could not find that role."); cleanup(r); return; }
    await message.delete().catch(() => {});

    if (dmText) {
      await message.guild.members.fetch();
      const members = message.guild.members.cache.filter((m) => m.roles.cache.has(role.id) && !m.user.bot);
      const embed = new EmbedBuilder()
        .setColor("#2563eb")
        .setTitle("Order Team")
        .setDescription(dmText)
        .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
        .setFooter({ text: `${message.guild.name} • Sent by ${message.author.username}` })
        .setTimestamp();
      let sent = 0, failed = 0;
      for (const [, m] of members) {
        try { await m.send({ embeds: [embed] }); sent++; } catch { failed++; }
      }
      const r = await message.channel.send(`✅ Embed DM sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
      cleanup(r, 10000);
      return;
    }

    const r = await message.channel.send({
      content: `Press the button below to send a DM to **${role.name}**.`,
      components: [buildDmComposerButton(role.id)],
    });
    cleanup(r, 15000);
    return;
  }

  if (command === "rpbreak") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    const orderRole = message.guild.roles.cache.find((r) => r.name.toLowerCase().includes("order team") || r.name.toLowerCase() === "order");
    if (!orderRole) { const r = await message.channel.send("Could not find the Order Team role."); cleanup(r); return; }
    await message.guild.members.fetch();
    const members = message.guild.members.cache.filter((m) => m.roles.cache.has(orderRole.id) && !m.user.bot);
    const attachment = new AttachmentBuilder(path.join(process.cwd(), "assets", "rpbreak.png"), { name: "rpbreak.png" });
    const embed = new EmbedBuilder()
      .setColor("#1e40af").setTitle("🚫  RP Break Notice")
      .setDescription("You are now placed on an **RP Break**.\n\nIf seen in RP during this time you will be **removed from the team**.")
      .setImage("attachment://rpbreak.png")
      .setFooter({ text: `${message.guild.name} • Issued by ${message.author.username}` }).setTimestamp();
    let sent = 0, failed = 0;
    for (const [, m] of members) {
      try { await m.send({ embeds: [embed], files: [attachment] }); sent++; } catch { failed++; }
    }
    const r = await message.channel.send(`✅ RP Break notice sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
    cleanup(r, 10000);
    return;
  }

  if (command === "rpbreakend") {
    if (!hasModeratorRole(message.member)) { const r = await message.reply("Only moderators can use this."); cleanup(r); return; }
    await message.delete().catch(() => {});
    const orderRole = message.guild.roles.cache.find((r) => r.name.toLowerCase().includes("order team") || r.name.toLowerCase() === "order");
    if (!orderRole) { const r = await message.channel.send("Could not find the Order Team role."); cleanup(r); return; }
    await message.guild.members.fetch();
    const members = message.guild.members.cache.filter((m) => m.roles.cache.has(orderRole.id) && !m.user.bot);
    const attachment = new AttachmentBuilder(path.join(process.cwd(), "assets", "rpbreakend.png"), { name: "rpbreakend.png" });
    const embed = new EmbedBuilder()
      .setColor("#22c55e").setTitle("✅  RP Break Lifted")
      .setDescription("The RP Break has been **lifted**.\n\nYou can now return back to RP — make sure to follow server rules.")
      .setImage("attachment://rpbreakend.png")
      .setFooter({ text: `${message.guild.name} • Issued by ${message.author.username}` }).setTimestamp();
    let sent = 0, failed = 0;
    for (const [, m] of members) {
      try { await m.send({ embeds: [embed], files: [attachment] }); sent++; } catch { failed++; }
    }
    const r = await message.channel.send(`✅ RP Break end sent to **${sent}** member(s)${failed ? ` (${failed} unreachable)` : ""}.`);
    cleanup(r, 10000);
    return;
  }
});

client.login(TOKEN).catch((e) => { log.error("Login failed:", e); process.exit(1); });
