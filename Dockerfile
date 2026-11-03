FROM node:24-alpine AS video_builder
RUN apk add --no-cache ffmpeg
WORKDIR /build
COPY videos/ ./videos/
RUN ffmpeg -nostdin -hide_banner -loglevel error -y \
      -i videos/guia-inicio-android.mp4 \
      -i videos/locucion-android.wav \
      -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k \
      -af apad -shortest -movflags +faststart \
      videos/guia-inicio-android-voz.mp4 \
    && ffmpeg -nostdin -hide_banner -loglevel error -y \
      -i videos/guia-inicio-iphone.mp4 \
      -i videos/locucion-iphone.wav \
      -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k \
      -af apad -shortest -movflags +faststart \
      videos/guia-inicio-iphone-voz.mp4

FROM node:24-alpine
RUN apk add --no-cache openssl
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_FILE=/data/tonusco.json
WORKDIR /app
COPY server.js index.html logo-tonusco.jpg package.json ./
COPY --from=video_builder /build/videos/guia-inicio-android-voz.mp4 ./videos/guia-inicio-android.mp4
COPY --from=video_builder /build/videos/guia-inicio-iphone-voz.mp4 ./videos/guia-inicio-iphone.mp4
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
