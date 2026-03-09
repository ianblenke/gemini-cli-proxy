FROM node:20-slim

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package.json ./
RUN npm install

# Bundle app source
COPY server.js ./

# Set environment
ENV HOME=/home/node
USER 1000

# Expose port
EXPOSE 4000

# Start the server
CMD [ "npm", "start" ]
