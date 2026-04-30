import WAEndmin from "@modules/baileys/main"

async function start() {
    await WAEndmin.startWhatsapp()
}

start().catch(console.error)