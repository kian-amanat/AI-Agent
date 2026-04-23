FROM dockerproxy.com/library/node:20

WORKDIR /app

# تنظیم رجیستری برای npm
RUN npm config set registry https://mirror-npm.runflare.com

COPY package*.json ./
RUN npm install

# نصب پلی‌رایت
RUN npx playwright install --with-deps

COPY . .

RUN mkdir /workspace

EXPOSE 3000

CMD ["node","server.js"]
