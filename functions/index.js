export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);

    // اگر کاربر مستقیماً آدرس اصلی یا خود index.html را خواست، بگذار مستقیم فرانت‌اَند لود شود
    if (url.pathname === "/" || url.pathname === "/index.html") {
        return context.next();
    }

    // در غیر این صورت پیغام خطا برای مسیرهای تعریف نشده
    return new Response("Not Found", { status: 404 });
}
