const { Client, GatewayIntentBits, ApplicationCommandOptionType } = require('discord.js');
const { 
    joinVoiceChannel, 
    createAudioPlayer, 
    createAudioResource, 
    AudioPlayerStatus, 
    getVoiceConnection 
} = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');
require('dotenv').config();

// ==========================================
// 1. WEB SERVER TÍCH HỢP (HỖ TRỢ HOSTING)
// ==========================================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🤖 Bot nhạc đang hoạt động trực tuyến 24/7!');
});

app.listen(PORT, () => {
    console.log(`[Web Server] Đang chạy thành công tại port: ${PORT}`);
});

// ==========================================
// 2. KHỞI TẠO DISCORD BOT CLIENT
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates // Cần thiết để tham gia và quản lý kênh voice
    ]
});

const queues = new Map(); // Lưu trữ hàng chờ phát nhạc cho từng Server (Guild)

// Đăng ký Slash Commands khi bot đã sẵn sàng
client.once('ready', async () => {
    console.log(`[Bot] Đã đăng nhập dưới tên: ${client.user.tag}`);

    const commands = [
        {
            name: 'help',
            description: 'Hiển thị danh sách các lệnh của bot.'
        },
        {
            name: 'join',
            description: 'Yêu cầu bot kết nối vào kênh voice của bạn.'
        },
        {
            name: 'play',
            description: 'Phát nhạc từ URL YouTube hoặc tìm kiếm bằng từ khóa.',
            options: [
                {
                    name: 'query',
                    type: ApplicationCommandOptionType.String,
                    description: 'Nhập link YouTube hoặc từ khóa tìm kiếm bài hát',
                    required: true
                }
            ]
        },
        {
            name: 'skip',
            description: 'Bỏ qua bài hát hiện tại để phát bài kế tiếp.'
        },
        {
            name: 'stop',
            description: 'Dừng phát nhạc, xóa hàng chờ và rời kênh voice.'
        }
    ];

    try {
        await client.application.commands.set(commands);
        console.log('[Bot] Đã đăng ký hệ thống lệnh Slash toàn cầu thành công!');
    } catch (error) {
        console.error('[Bot Lỗi] Đăng ký Slash Commands thất bại:', error);
    }
});

// Hàm hỗ trợ phát nhạc từ hàng chờ
async function playSong(guildId, song) {
    const guildQueue = queues.get(guildId);
    if (!guildQueue) return;

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, {
            inputType: stream.type
        });

        guildQueue.player.play(resource);
        guildQueue.textChannel.send(`🎶 Đang phát: **${song.title}**\n🔗 Link: <${song.url}>`);
    } catch (error) {
        console.error('[Bot Lỗi] Phát nhạc gặp sự cố:', error);
        guildQueue.textChannel.send(`❌ Có lỗi xảy ra khi cố gắng phát bài: **${song.title}**`);
        
        // Chuyển nhanh sang bài tiếp theo nếu bài hiện tại lỗi
        guildQueue.songs.shift();
        if (guildQueue.songs.length > 0) {
            playSong(guildId, guildQueue.songs[0]);
        }
    }
}

// Xử lý tương tác Slash Commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    // Lệnh /help
    if (commandName === 'help') {
        const helpMessage = `
**Danh sách lệnh Slash của Bot:**
• \`/help\` : Hiển thị bảng hướng dẫn này.
• \`/join\` : Yêu cầu bot kết nối vào kênh voice bạn đang đứng.
• \`/play <link/từ khóa>\` : Tìm và phát nhạc từ YouTube (hỗ trợ hàng chờ).
• \`/skip\` : Bỏ qua bài hát hiện tại để chuyển sang bài kế tiếp.
• \`/stop\` : Dừng phát nhạc, xóa hàng chờ và rời kênh voice.
        `;
        return interaction.reply({ content: helpMessage, ephemeral: true });
    }

    // Lệnh /join
    if (commandName === 'join') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Bạn cần tham gia vào một kênh voice trước!', ephemeral: true });
        }

        const botConnection = getVoiceConnection(interaction.guild.id);
        if (botConnection) {
            return interaction.reply({ content: '❌ Bot đã ở trong một kênh voice rồi!', ephemeral: true });
        }

        joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        return interaction.reply(`🔊 Đã kết nối thành công vào kênh: **${voiceChannel.name}**`);
    }

    // Lệnh /play
    if (commandName === 'play') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Bạn cần tham gia vào một kênh voice trước!', ephemeral: true });
        }

        const botConnection = getVoiceConnection(interaction.guild.id);
        if (botConnection && interaction.guild.members.me.voice.channelId !== voiceChannel.id) {
            return interaction.reply({ content: '❌ Bạn cần ở cùng một kênh voice với bot để dùng lệnh này!', ephemeral: true });
        }

        const query = interaction.options.getString('query');

        // Tránh tình trạng bot bị quá hạn phản hồi (3 giây) trong lúc tìm kiếm
        await interaction.deferReply();

        try {
            let songUrl = '';
            let songTitle = '';

            // Phân loại đầu vào (Link hoặc Từ khóa)
            if (query.startsWith('http') && play.yt_validate(query) !== 'search') {
                const videoInfo = await play.video_info(query);
                songUrl = videoInfo.video_details.url;
                songTitle = videoInfo.video_details.title;
            } else {
                const searchResults = await play.search(query, { limit: 1 });
                if (!searchResults || searchResults.length === 0) {
                    return interaction.editReply('❌ Không tìm thấy kết quả phù hợp trên YouTube!');
                }
                songUrl = searchResults[0].url;
                songTitle = searchResults[0].title;
            }

            let connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                });
            }

            let guildQueue = queues.get(interaction.guild.id);
            if (!guildQueue) {
                const player = createAudioPlayer();
                connection.subscribe(player);

                guildQueue = {
                    connection,
                    player,
                    songs: [],
                    textChannel: interaction.channel,
                    timeout: null
                };

                queues.set(interaction.guild.id, guildQueue);

                // Lắng nghe sự kiện chuyển bài hát tiếp theo khi rảnh rỗi (Idle)
                player.on(AudioPlayerStatus.Idle, () => {
                    guildQueue.songs.shift();
                    if (guildQueue.songs.length > 0) {
                        playSong(interaction.guild.id, guildQueue.songs[0]);
                    } else {
                        // Tự động ngắt kết nối sau 3 phút nhàn rỗi (tránh treo VPS vô ích)
                        guildQueue.timeout = setTimeout(() => {
                            const conn = getVoiceConnection(interaction.guild.id);
                            if (conn) conn.destroy();
                            queues.delete(interaction.guild.id);
                            guildQueue.textChannel.send('💤 Bot đã rời kênh voice do không có bài hát nào được phát thêm trong 3 phút.');
                        }, 180000);
                    }
                });

                player.on('error', (error) => {
                    console.error(`[Audio Player Error] Lỗi: ${error.message}`);
                    guildQueue.textChannel.send(`❌ Lỗi phát nhạc: ${error.message}`);
                    guildQueue.songs.shift();
                    if (guildQueue.songs.length > 0) {
                        playSong(interaction.guild.id, guildQueue.songs[0]);
                    }
                });
            }

            // Hủy đếm ngược rời kênh nếu người dùng thêm bài hát mới vào hàng chờ
            if (guildQueue.timeout) {
                clearTimeout(guildQueue.timeout);
                guildQueue.timeout = null;
            }

            guildQueue.songs.push({ title: songTitle, url: songUrl });

            if (guildQueue.songs.length === 1) {
                await interaction.editReply(`⏳ Đang tiến hành tải bài hát...`);
                await playSong(interaction.guild.id, guildQueue.songs[0]);
                await interaction.deleteReply().catch(() => {});
            } else {
                await interaction.editReply(`📥 Đã xếp hàng chờ tại vị trí **#${guildQueue.songs.length}**: **${songTitle}**`);
            }

        } catch (error) {
            console.error('[Bot Lỗi] Không xử lý được lệnh play:', error);
            await interaction.editReply(`❌ Gặp lỗi kết nối hoặc phân tích nhạc: ${error.message}`);
        }
    }

    // Lệnh /skip
    if (commandName === 'skip') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Bạn phải ở trong một kênh voice trước!', ephemeral: true });
        }

        const guildQueue = queues.get(interaction.guild.id);
        if (!guildQueue || guildQueue.songs.length === 0) {
            return interaction.reply({ content: '❌ Hiện không có bài hát nào đang phát!', ephemeral: true });
        }

        guildQueue.player.stop(); // Tự động kích hoạt luồng Idle để nhảy bài
        return interaction.reply('⏭️ Đã bỏ qua bài hát hiện tại.');
    }

    // Lệnh /stop
    if (commandName === 'stop') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '❌ Bạn phải ở trong một kênh voice trước!', ephemeral: true });
        }

        const connection = getVoiceConnection(interaction.guild.id);
        if (!connection) {
            return interaction.reply({ content: '❌ Hiện bot không tham gia kênh voice nào!', ephemeral: true });
        }

        const guildQueue = queues.get(interaction.guild.id);
        if (guildQueue) {
            if (guildQueue.timeout) clearTimeout(guildQueue.timeout);
            guildQueue.songs = [];
            guildQueue.player.stop();
        }

        connection.destroy();
        queues.delete(interaction.guild.id);

        return interaction.reply('⏹️ Đã dừng phát nhạc, xóa sạch hàng chờ và rời kênh voice.');
    }
});

client.login(process.env.DISCORD_TOKEN);