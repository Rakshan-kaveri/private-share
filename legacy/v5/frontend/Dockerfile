FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.html ./
COPY src ./src
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_ICE_SERVERS_JSON=[]
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID VITE_ICE_SERVERS_JSON=$VITE_ICE_SERVERS_JSON
RUN npm run build
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
