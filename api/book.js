export default async function handler(req, res) {
    const { file } = req.query
    if (!file || file.includes('/') || file.includes('..')) {
        return res.status(400).json({ error: 'Invalid file parameter' })
    }

    const url = `https://storage.yandexcloud.net/bookguesser/books/${file}`
    const upstream = await fetch(url)

    if (!upstream.ok) {
        return res.status(upstream.status).json({ error: 'File not found' })
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=86400')

    const buffer = await upstream.arrayBuffer()
    res.send(Buffer.from(buffer))
}
